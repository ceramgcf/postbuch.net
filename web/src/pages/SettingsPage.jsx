import { useState, useEffect, useCallback, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams, Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '@/api/client';
import { pushApi } from '@/api/push';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Dialog, DialogTitle, DialogDescription, DialogFooter } from '@/components/ui/dialog';
import { Spinner, EmptyState } from '@/components/ui/spinner';
import { Testergebnis } from '@/components/ui/testergebnis';
import { JobFortschritt } from '@/components/ui/job-fortschritt';
import { useAuth } from '@/hooks/useAuth';
import { usePushSubscription } from '@/hooks/usePushSubscription';
import { useNeustartWarten } from '@/hooks/useNeustartWarten';
import {
  Settings, Cloud, FolderOpen, Wand2, CheckCircle2,
  AlertCircle, RefreshCw, Link2, Unlink2, Pencil, Save, X,
  Archive, Play, RotateCcw, AlertTriangle, CheckCircle, ChevronDown, ChevronRight, Upload, Check,
  Users, UserPlus, ArchiveRestore, Trash2, Bot, Globe, Eye, EyeOff,
  Database, Key, ShieldCheck, ShieldX, ScanLine, BellRing, Bell, BellOff,
  LifeBuoy, Fingerprint, Search, Cpu, Coins, MessageSquare,
  FileText, RotateCw, AlertOctagon, Copy, CalendarClock, Euro,
  Folder, Plus, Printer, Bluetooth, BluetoothConnected, BluetoothOff, BluetoothSearching,
  Plug, KeyRound, Server, HardDrive, ArrowLeftRight, Lock, FolderTree,
} from 'lucide-react';
import { usePrinter } from '@/contexts/PrinterContext';
import BackupWarnung from '@/components/BackupWarnung';
import NextcloudCard from '@/components/settings/NextcloudCard';
import ProviderCard from '@/components/settings/ProviderCard';
import EmbeddingCard from '@/components/settings/EmbeddingCard';
import CloudfreiCard from '@/components/settings/CloudfreiCard';
import PushInstanzCard from '@/components/settings/PushInstanzCard';
import UpdateCard from '@/components/settings/UpdateCard';
import EmpfehlungenCard from '@/components/settings/EmpfehlungenCard';
import ModelSelector from '@/components/settings/ModelSelector';
import ScannerDiscoveryCard from '@/components/settings/ScannerDiscoveryCard';
import OneDriveSection from '@/components/settings/OneDriveSection';
import { SetupGuideCard, SetupStepList } from '@/components/settings/SetupGuide';
import MenschenCard from '@/components/settings/MenschenCard';
import KostentraegerProfilCard from '@/components/settings/KostentraegerProfilCard';
import { MODEL_CLASSES } from '@/components/settings/modelClasses';
import { renderLabelCanvas } from '@/lib/labelRenderer';
import { gleichesModell } from '@/lib/modellId';
import {
  useVerbleibKategorienAll,
  useCreateVerbleibKategorie,
  useUpdateVerbleibKategorie,
  useArchiveVerbleibKategorie,
} from '@/hooks/useVerbleib';
import * as LucideIcons from 'lucide-react';

const SYSTEM_FOLDER_KEYS = ['inbox', 'failed', 'suspended', 'trash', 'backup', 'abrechnungMerged', 'debug'];

// ── Backup helpers ────────────────────────────────────────────────────────────

function formatBytes(bytes) {
  if (!bytes) return '–';
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${(bytes / 1024).toFixed(0)} KB`;
}

function formatDateTime(iso) {
  if (!iso) return '–';
  return new Date(iso).toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function groupBackupsByAge(files) {
  const now = new Date();
  const dow = now.getDay();
  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - (dow === 0 ? 6 : dow - 1));
  startOfWeek.setHours(0, 0, 0, 0);
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfYear  = new Date(now.getFullYear(), 0, 1);
  const week = [], month = [], year = [], older = [];
  for (const f of files) {
    const d = new Date(f.createdDateTime);
    if (d >= startOfWeek)       week.push(f);
    else if (d >= startOfMonth) month.push(f);
    else if (d >= startOfYear)  year.push(f);
    else                        older.push(f);
  }
  return [
    { key: 'week',  label: 'Diese Woche',  files: week,  defaultOpen: true  },
    { key: 'month', label: 'Diesen Monat', files: month, defaultOpen: false },
    { key: 'year',  label: 'Dieses Jahr',  files: year,  defaultOpen: false },
    { key: 'older', label: 'Älter',        files: older, defaultOpen: false },
  ].filter((g) => g.files.length > 0);
}

/**
 * Selbst ausgelöste Sicherung starten und bis zum Ende verfolgen. Den Zustand
 * hält der Server (jobs/backup.js), hier wird nur gepollt.
 */
function useVorabSicherung() {
  const [lauf, setLauf] = useState(null);
  const [startFehler, setStartFehler] = useState('');
  const timer = useRef(null);

  const stoppePolling = useCallback(() => {
    if (timer.current) { clearInterval(timer.current); timer.current = null; }
  }, []);
  useEffect(() => stoppePolling, [stoppePolling]);

  const starten = useCallback(async () => {
    setStartFehler('');
    stoppePolling();
    try {
      const gestartet = await api.backup.manuellStarten();
      setLauf(gestartet);
      if (gestartet?.status !== 'laeuft') return;
      timer.current = setInterval(async () => {
        try {
          const stand = await api.backup.manuellStatus();
          if (!stand) return;
          setLauf(stand);
          if (stand.status !== 'laeuft') stoppePolling();
        } catch { /* App kurz nicht erreichbar – weiter pollen */ }
      }, 2000);
    } catch (err) {
      setStartFehler(err.message);
    }
  }, [stoppePolling]);

  const zuruecksetzen = useCallback(() => {
    stoppePolling();
    setLauf(null);
    setStartFehler('');
  }, [stoppePolling]);

  return { lauf, startFehler, starten, zuruecksetzen };
}

/**
 * Freigabe des Restore-Knopfes. Entweder die Zwangssicherung ist durchgelaufen –
 * dann reist ihre ID als Nachweis mit –, oder sie ist gescheitert und der Nutzer
 * entscheidet sich nach der Warnung bewusst dagegen. Solange keins von beidem
 * gilt, liefert die Funktion null und der Knopf bleibt gesperrt.
 */
function restoreArgumente(sicherung) {
  if (sicherung.lauf?.status === 'fertig') return { vorabSicherungId: sicherung.lauf.id };
  if (sicherung.startFehler || sicherung.lauf?.status === 'fehler') return { ohneVorabSicherung: true };
  return null;
}

/** Kennzeichnung verschlüsselter Sicherungen in der Liste. */
function VerschluesseltBadge() {
  return (
    <span
      title="Verschlüsselt – wird mit dem Schlüsselbund dieser Instanz automatisch geöffnet, sonst mit dem Backup-Passwort"
      className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-400"
    >
      <Lock className="h-3 w-3" />Verschlüsselt
    </span>
  );
}

const BACKUP_PASSWORT_CODES = new Set(['PASSWORT_ERFORDERLICH', 'BACKUP_PASSWORT_FALSCH']);

/**
 * Passwortabfrage im Restore-Dialog. Erscheint erst, wenn der Server meldet,
 * dass der Schlüsselbund dieser Instanz die Datei nicht öffnet.
 */
// Tab-lokaler Ladefehler: statt eines endlosen „Lade…“ ein Ausweg ohne
// Seitenwechsel.
function EinstellungenLadefehler({ fehler, onRetry, laedt }) {
  return (
    <EmptyState icon={AlertTriangle} title="Einstellungen konnten nicht geladen werden" description={fehler?.message || 'Der Server antwortet gerade nicht.'}>
      <Button onClick={() => onRetry()} disabled={laedt}>{laedt ? <Spinner className="h-4 w-4" /> : <RefreshCw className="h-4 w-4" />}Erneut laden</Button>
    </EmptyState>
  );
}

function RestoreNeustartInhalt({ neustart }) {
  if (neustart.zustand === 'zeitueberschritten') {
    return (
      <>
        <DialogTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-amber-500 flex-shrink-0" />Neustart dauert länger</DialogTitle>
        <DialogDescription className="mt-3 space-y-2">
          <p>Die Datenbank wurde wiederhergestellt, aber postbuch.net meldet sich nach zwei Minuten noch nicht zurück.</p>
          <p>Du kannst erneut prüfen oder es direkt mit der Anmeldung versuchen. Hält der Zustand an, hilft ein Blick in die Container-Logs.</p>
        </DialogDescription>
        <DialogFooter>
          <Button variant="outline" onClick={() => { window.location.href = '/login'; }}>Zur Anmeldung</Button>
          <Button onClick={neustart.starten}><RefreshCw className="h-4 w-4" />Erneut prüfen</Button>
        </DialogFooter>
      </>
    );
  }
  return (
    <>
      <DialogTitle>Restore erfolgreich</DialogTitle>
      <DialogDescription className="mt-3 space-y-2">
        <p>Die Datenbank wurde wiederhergestellt. Die Anwendung wird neu gestartet.</p>
        <div className="flex items-center gap-2 pt-1"><RefreshCw className="h-4 w-4 animate-spin text-primary" /><span className="text-sm">App startet neu…</span></div>
      </DialogDescription>
    </>
  );
}

function BackupPasswortFeld({ wert, onChange, gesperrt }) {
  return (
    <div className="mt-3 space-y-1.5 rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2.5">
      <label htmlFor="restore-backup-passwort" className="text-sm font-medium flex items-center gap-1.5">
        <KeyRound className="h-4 w-4" />Backup-Passwort
      </label>
      <Input
        id="restore-backup-passwort"
        type="password"
        autoComplete="off"
        value={wert}
        onChange={(e) => onChange(e.target.value)}
        disabled={gesperrt}
        className="h-9"
      />
      <p className="text-xs text-muted-foreground leading-relaxed">
        Der Schlüssel dieser Datei ist dieser Instanz nicht bekannt. Es genügt das zuletzt gesetzte
        Backup-Passwort der Instanz, die die Datei erstellt hat, oder das beim Erstellen der Datei gültige Passwort.
      </p>
    </div>
  );
}

/** Kennzeichnung selbst ausgelöster Sicherungen in der Liste. */
function HandBadge() {
  return (
    <span
      title="Von Hand ausgelöst – liegt in _backup/user und wird nie automatisch gelöscht"
      className="inline-flex items-center gap-1 rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary"
    >
      <ShieldCheck className="h-3 w-3" />Von Hand
    </span>
  );
}

/**
 * Pflicht-Zwischenschritt vor jedem Restore: erst den aktuellen Stand sichern,
 * dann wiederherstellen. Zeigt Start, Fortschritt, Erfolg – oder die Warnung,
 * dass es ohne Sicherung keinen Weg zurück gibt.
 */
function VorabSicherungBlock({ sicherung, gesperrt }) {
  const status = sicherung.startFehler ? 'fehler' : (sicherung.lauf?.status ?? null);

  if (status === 'laeuft') {
    return (
      <div className="mt-3 flex items-center gap-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm">
        <RefreshCw className="h-4 w-4 animate-spin text-primary flex-shrink-0" />
        <span>Sicherung läuft – bitte warten. Danach wird das Wiederherstellen freigegeben.</span>
      </div>
    );
  }

  if (status === 'fertig') {
    return (
      <div className="mt-3 flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-3 py-2.5 text-sm">
        <CheckCircle className="h-4 w-4 text-emerald-600 dark:text-emerald-400 flex-shrink-0 mt-0.5" />
        <span>
          Aktueller Stand gesichert{sicherung.lauf?.dateiname ? <> als <span className="font-mono text-xs">{sicherung.lauf.dateiname}</span></> : null}
          {' '}in <span className="font-mono text-xs">_backup/user</span>.
        </span>
      </div>
    );
  }

  if (status === 'fehler') {
    return (
      <div className="mt-3 space-y-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-sm">
        <p className="flex items-start gap-2 font-medium text-destructive">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          Die Sicherung ist fehlgeschlagen: {sicherung.startFehler || sicherung.lauf?.fehler}
        </p>
        <p className="text-destructive/90">
          Ohne sie gibt es keinen Weg zurück: Der aktuelle Datenbestand wird überschrieben und ist danach
          unwiederbringlich verloren.
        </p>
        <Button variant="outline" size="sm" className="h-7 text-xs" onClick={sicherung.starten} disabled={gesperrt}>
          <RefreshCw className="h-3 w-3 mr-1.5" />Sicherung erneut versuchen
        </Button>
      </div>
    );
  }

  return (
    <div className="mt-3 space-y-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 text-sm">
      <p>
        Zuerst sichert postbuch.net den <strong>aktuellen</strong> Stand nach
        {' '}<span className="font-mono text-xs">_backup/user</span>. Diese Sicherung wird nie automatisch gelöscht.
      </p>
      <Button size="sm" className="h-7 text-xs" onClick={sicherung.starten} disabled={gesperrt}>
        <Play className="h-3 w-3 mr-1.5" />Sicherung starten
      </Button>
    </div>
  );
}

function BackupGroupSection({ group, onRestore }) {
  const [open, setOpen] = useState(group.defaultOpen);
  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="w-full flex items-center justify-between px-4 py-2 bg-muted/40 hover:bg-muted/60 transition-colors border-y border-border/40 text-xs font-semibold text-muted-foreground uppercase tracking-wider"
      >
        <span className="flex items-center gap-2">
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          {group.label}
        </span>
        <span className="font-normal normal-case tracking-normal">{group.files.length}</span>
      </button>
      {open && (
        <div className="divide-y divide-border/40">
          {group.files.map((f) => (
            <div key={f.id} className="flex items-center px-4 py-2.5 hover:bg-muted/30 transition-colors gap-3">
              <div className="flex-1 min-w-0">
                <p className="font-mono text-xs truncate">{f.name}</p>
                <p className="text-[11px] text-muted-foreground mt-0.5 flex items-center gap-1.5 flex-wrap">
                  {f.manuell && <HandBadge />}
                  {f.encrypted && <VerschluesseltBadge />}
                  <span>
                    {f.appVersion ? <>App v{f.appVersion}</> : 'App-Version unbekannt'}
                    {f.schemaFingerprint && <> · Schema {f.schemaFingerprint.slice(0, 12)}</>}
                  </span>
                </p>
              </div>
              <span className="text-xs text-muted-foreground whitespace-nowrap hidden sm:block">{formatDateTime(f.createdDateTime)}</span>
              <span className="text-xs text-muted-foreground text-right whitespace-nowrap hidden sm:block w-20">{formatBytes(f.size)}</span>
              <Button variant="outline" size="sm" className="h-7 text-xs text-destructive border-destructive/30 hover:bg-destructive/5 hover:border-destructive/60 flex-shrink-0" onClick={() => onRestore(f)}>
                <RotateCcw className="h-3 w-3 mr-1.5" />Wiederherstellen
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Backup Tab ────────────────────────────────────────────────────────────────

function BackupTab() {
  const qc = useQueryClient();
  const { data: settings, isLoading: settingsLoading } = useQuery({ queryKey: ['backup', 'settings'], queryFn: () => api.backup.getSettings() });
  const [localEnabled, setLocalEnabled] = useState(null);
  const [localCron, setLocalCron]       = useState(null);
  const enabled = localEnabled !== null ? localEnabled : (settings?.enabled ?? false);
  const cron    = localCron    !== null ? localCron    : (settings?.cron    ?? '0 4 * * *');
  const settingsMutation = useMutation({
    mutationFn: (data) => api.backup.updateSettings(data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['backup', 'settings'] }); setLocalEnabled(null); setLocalCron(null); },
  });
  function speichereBackupSettings() {
    if (!enabled) {
      const bestaetigung = window.prompt('Backups wirklich abschalten? Tippe NOBACKUP zur Bestätigung.');
      if (bestaetigung !== 'NOBACKUP') return;
      settingsMutation.mutate({ enabled, cron, bestaetigung, bewusst: true });
      return;
    }
    settingsMutation.mutate({ enabled, cron });
  }
  // ── Backup-Verschlüsselung ─────────────────────────────────────────────────
  const encryption = settings?.encryption ?? { enabled: false, entschieden: false, passwortGesetzt: false };
  const [encFormOffen, setEncFormOffen] = useState(false);
  const [encNeuesPasswort, setEncNeuesPasswort] = useState(false); // Passwort ändern statt erstmalig setzen
  const [encPasswort, setEncPasswort] = useState('');
  const [encPasswortWiederholung, setEncPasswortWiederholung] = useState('');
  const [zeigeEncPasswort, setZeigeEncPasswort] = useState(false);
  const encryptionMutation = useMutation({
    mutationFn: (data) => api.backup.updateEncryption(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['backup', 'settings'] });
      setEncFormOffen(false);
      setEncNeuesPasswort(false);
      setEncPasswort('');
      setEncPasswortWiederholung('');
    },
  });
  function oeffneEncFormular(neuesPasswort) {
    setEncNeuesPasswort(neuesPasswort);
    setEncPasswort('');
    setEncPasswortWiederholung('');
    setEncFormOffen(true);
  }
  function speichereEncPasswort() {
    encryptionMutation.mutate({
      enabled: true,
      passwort: encPasswort,
      passwortWiederholung: encPasswortWiederholung,
      ...(encNeuesPasswort ? { neuesPasswort: true } : {}),
    });
  }
  function deaktiviereVerschluesselung() {
    const bestaetigung = window.prompt(
      'Backup-Verschlüsselung wirklich abschalten?\n\n'
      + 'Künftige Backups werden dann unverschlüsselt abgelegt. Bereits vorhandene '
      + 'verschlüsselte Backups bleiben verschlüsselt. Diese Instanz öffnet sie weiterhin '
      + 'ohne Passworteingabe; Schlüssel und Passwort bleiben erhalten und gelten auch '
      + 'beim späteren Wiedereinschalten.\n\n'
      + 'Tippe UNVERSCHLÜSSELT zur Bestätigung.'
    );
    if (bestaetigung !== 'UNVERSCHLÜSSELT') return;
    encryptionMutation.mutate({ enabled: false, bewusst: true });
  }
  const [revealOffen, setRevealOffen] = useState(false);
  const [revealAppPasswort, setRevealAppPasswort] = useState('');
  const revealMutation = useMutation({
    mutationFn: (appPasswort) => api.backup.revealEncryptionPasswort(appPasswort),
  });
  function oeffneReveal() {
    setRevealAppPasswort('');
    revealMutation.reset();
    setRevealOffen(true);
  }
  // „Jetzt sichern": selbst ausgelöste Sicherung nach _backup/user, mit echtem
  // Fortschritt statt eines Fire-and-forget-Hinweises.
  const handSicherung = useVorabSicherung();
  const handLaeuft = handSicherung.lauf?.status === 'laeuft';
  const handStatus = handSicherung.lauf?.status;
  useEffect(() => {
    if (handStatus === 'fertig') qc.invalidateQueries({ queryKey: ['backup', 'files'] });
  }, [handStatus, qc]);
  const { data: files = [], isLoading: filesLoading, refetch: refetchFiles } = useQuery({ queryKey: ['backup', 'files'], queryFn: () => api.backup.listFiles(), retry: false });
  const groups = groupBackupsByAge(files);
  const [restoreTarget, setRestoreTarget] = useState(null);
  const [restoreSuccess, setRestoreSuccess] = useState(false);
  const restoreNeustart = useNeustartWarten();
  const [restoreError, setRestoreError]   = useState('');
  const restoreSicherung = useVorabSicherung();
  // Backup-Passwort: nur gefragt, wenn der Server den Schlüssel nicht kennt.
  const [restorePasswortNoetig, setRestorePasswortNoetig] = useState(false);
  const [restorePasswort, setRestorePasswort] = useState('');
  function restoreDialogZuruecksetzen() {
    setRestoreSuccess(false);
    setRestoreError('');
    setRestorePasswortNoetig(false);
    setRestorePasswort('');
    restoreSicherung.zuruecksetzen();
  }
  const restoreMutation = useMutation({
    mutationFn: ({ fileId, vorabSicherungId, ohneVorabSicherung }) =>
      api.backup.restore(fileId, { vorabSicherungId, ohneVorabSicherung, backupPasswort: restorePasswort || undefined }),
    onSuccess: () => {
      setRestoreSuccess(true);
      restoreNeustart.starten();
    },
    onError: (err) => {
      if (BACKUP_PASSWORT_CODES.has(err.payload?.code)) setRestorePasswortNoetig(true);
      // Die erste Rückfrage erklärt das Passwortfeld selbst, kein roter Fehler.
      setRestoreError(err.payload?.code === 'PASSWORT_ERFORDERLICH' ? '' : err.message);
    },
  });
  const [uploadFile, setUploadFile] = useState(null);
  const [uploadRestoreOpen, setUploadRestoreOpen] = useState(false);
  const [uploadRestoreSuccess, setUploadRestoreSuccess] = useState(false);
  const uploadNeustart = useNeustartWarten();
  const [uploadRestoreError, setUploadRestoreError] = useState('');
  const uploadSicherung = useVorabSicherung();
  const [uploadPasswortNoetig, setUploadPasswortNoetig] = useState(false);
  const [uploadPasswort, setUploadPasswort] = useState('');
  function uploadDialogZuruecksetzen() {
    setUploadRestoreSuccess(false);
    setUploadRestoreError('');
    setUploadPasswortNoetig(false);
    setUploadPasswort('');
    uploadSicherung.zuruecksetzen();
  }
  const uploadRestoreMutation = useMutation({
    mutationFn: ({ vorabSicherungId, ohneVorabSicherung } = {}) =>
      api.backup.restoreUpload(uploadFile, { vorabSicherungId, ohneVorabSicherung, backupPasswort: uploadPasswort || undefined }),
    onSuccess: () => {
      setUploadRestoreSuccess(true);
      uploadNeustart.starten();
    },
    onError: (err) => {
      if (BACKUP_PASSWORT_CODES.has(err.payload?.code)) setUploadPasswortNoetig(true);
      setUploadRestoreError(err.payload?.code === 'PASSWORT_ERFORDERLICH' ? '' : err.message);
    },
  });

  return (
    <div className="space-y-6">
      <BackupWarnung />
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Backup-Einstellungen</CardTitle>
          <CardDescription className="text-xs">Automatischer Datenbank-Backup (pg_dump) in den konfigurierten OneDrive-Ordner.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!settingsLoading && !settings?.backupFolderConfigured && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2.5">
              <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Backup-Ordner nicht konfiguriert. Bitte unter <strong>OneDrive → Ordner-Zuordnung</strong> den Backup-Ordner hinterlegen.
              </p>
            </div>
          )}
          {settingsLoading ? <p className="text-sm text-muted-foreground">Lade…</p> : (
            <>
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm font-medium">Automatisches Backup</p>
                  <p className="text-xs text-muted-foreground mt-0.5">{enabled ? 'Aktiviert' : 'Deaktiviert'}</p>
                </div>
                <button type="button" onClick={() => setLocalEnabled(!enabled)} className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${enabled ? 'bg-primary' : 'bg-muted'}`}>
                  <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${enabled ? 'translate-x-6' : 'translate-x-1'}`} />
                </button>
              </div>
              <div className="space-y-1">
                <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Cron-Ausdruck</label>
                <Input value={cron} onChange={(e) => setLocalCron(e.target.value)} placeholder="0 4 * * *" className="h-9 font-mono text-sm" />
                <p className="text-xs text-muted-foreground">Beispiel: <code className="font-mono">0 4 * * *</code> = täglich um 04:00 Uhr (Berlin)</p>
              </div>
              {settingsMutation.isError && <p className="text-sm text-destructive">{settingsMutation.error?.message}</p>}
              <Button size="sm" onClick={speichereBackupSettings} disabled={settingsMutation.isPending}>
                {settingsMutation.isPending ? 'Speichern…' : 'Einstellungen speichern'}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <KeyRound className="h-4 w-4" />
            Backup-Verschlüsselung
          </CardTitle>
          <CardDescription className="text-xs">
            Verschlüsselt künftige Backups mit einem Passwort, bevor sie in die Dateiablage (OneDrive/Nextcloud) hochgeladen werden.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">{encryption.enabled ? 'Aktiv' : 'Nicht aktiv'}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {encryption.enabled
                  ? 'Neue Backups werden verschlüsselt abgelegt.'
                  : encryption.entschieden
                    ? 'Bewusst ohne Verschlüsselung – jederzeit nachträglich aktivierbar.'
                    : 'Noch nicht entschieden.'}
              </p>
            </div>
            {encryption.enabled && <CheckCircle className="h-5 w-5 text-emerald-500 flex-shrink-0" />}
          </div>

          {!encFormOffen && (
            <div className="flex flex-wrap gap-2">
              {!encryption.enabled ? (
                <Button size="sm" onClick={() => oeffneEncFormular(false)}>
                  <KeyRound className="h-4 w-4 mr-2" />Verschlüsselung aktivieren
                </Button>
              ) : (
                <>
                  <Button size="sm" variant="outline" onClick={() => oeffneEncFormular(true)}>Passwort ändern</Button>
                  <Button size="sm" variant="outline" onClick={oeffneReveal}>
                    <Eye className="h-4 w-4 mr-2" />Passwort anzeigen
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="text-destructive border-destructive/30 hover:bg-destructive/5 hover:border-destructive/60"
                    onClick={deaktiviereVerschluesselung}
                  >
                    Verschlüsselung deaktivieren
                  </Button>
                </>
              )}
            </div>
          )}

          {encFormOffen && (
            <div className="space-y-3 rounded-lg border border-border/60 p-3">
              <div className="rounded-lg border-2 border-amber-500/40 bg-amber-500/8 px-3 py-2.5 space-y-1">
                <p className="text-xs font-semibold text-amber-700 dark:text-amber-500">
                  Notiere dir dieses Passwort jetzt – es verlässt dieses Gerät nie automatisch.
                </p>
                <p className="text-xs leading-relaxed text-amber-700/90 dark:text-amber-400/90">
                  Ohne dieses Passwort lässt sich ein damit erstelltes Backup nicht wiederherstellen – es gibt keinen Zurücksetzen-Mechanismus.
                  {encNeuesPasswort && (
                    <> Die Schlüsseldatei <span className="font-mono">_backup/schluessel.json</span> wird auf das neue Passwort umgestellt – zusammen mit ihr öffnet das neue Passwort auch alle bisherigen Backups. Eine einzelne ältere Backup-Datei <strong>ohne</strong> Schlüsseldatei braucht dagegen weiterhin ihr damaliges Passwort; notiere dir das alte deshalb ebenfalls.</>
                  )}
                </p>
              </div>
              <div className="space-y-2 max-w-sm">
                <div className="relative">
                  <Input
                    type={zeigeEncPasswort ? 'text' : 'password'}
                    value={encPasswort}
                    onChange={(e) => setEncPasswort(e.target.value)}
                    placeholder={encNeuesPasswort ? 'Neues Backup-Passwort' : 'Backup-Passwort (mind. 8 Zeichen)'}
                    className="h-9 text-sm pr-9"
                    autoComplete="new-password"
                  />
                  <button
                    type="button"
                    onClick={() => setZeigeEncPasswort(!zeigeEncPasswort)}
                    className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {zeigeEncPasswort ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
                <Input
                  type={zeigeEncPasswort ? 'text' : 'password'}
                  value={encPasswortWiederholung}
                  onChange={(e) => setEncPasswortWiederholung(e.target.value)}
                  placeholder="Passwort wiederholen"
                  className="h-9 text-sm"
                  autoComplete="new-password"
                />
                {encPasswort && encPasswortWiederholung && encPasswort !== encPasswortWiederholung && (
                  <p className="text-xs text-destructive">Passwörter stimmen nicht überein.</p>
                )}
              </div>
              {encryptionMutation.isError && <p className="text-sm text-destructive">{encryptionMutation.error?.message}</p>}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  onClick={speichereEncPasswort}
                  disabled={encryptionMutation.isPending || encPasswort.length < 8 || encPasswort !== encPasswortWiederholung}
                >
                  {encryptionMutation.isPending ? 'Speichern…' : (encNeuesPasswort ? 'Passwort ändern' : 'Verschlüsselung aktivieren')}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEncFormOffen(false)} disabled={encryptionMutation.isPending}>Abbrechen</Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Backup starten</CardTitle>
          <CardDescription className="text-xs">
            Sichert den aktuellen Stand sofort in den Unterordner <span className="font-mono">_backup/user</span>.
            Solche Sicherungen bleiben dauerhaft liegen – die automatische Ausdünnung rührt sie nicht an.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <Button size="sm" onClick={handSicherung.starten} disabled={handLaeuft}>
              <Play className="h-4 w-4 mr-2" />{handLaeuft ? 'Sicherung läuft…' : 'Jetzt sichern'}
            </Button>
            {handLaeuft && (
              <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                <RefreshCw className="h-4 w-4 animate-spin text-primary" />Bitte warten – die Sicherung läuft.
              </div>
            )}
            {handStatus === 'fertig' && (
              <div className="flex items-center gap-1.5 text-sm text-emerald-600 dark:text-emerald-400">
                <CheckCircle className="h-4 w-4" />Gesichert: <span className="font-mono text-xs">{handSicherung.lauf.dateiname}</span>
              </div>
            )}
          </div>
          {(handSicherung.startFehler || handStatus === 'fehler') && (
            <p className="text-sm text-destructive">
              Sicherung fehlgeschlagen: {handSicherung.startFehler || handSicherung.lauf?.fehler}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Verfügbare Backups</CardTitle>
              <CardDescription className="text-xs mt-0.5">
                Backups aus dem Dateiablage-Ordner <span className="font-mono">_backup</span> (.pgdump.gz).
                Als „Von Hand" markierte Einträge liegen in <span className="font-mono">_backup/user</span> und
                werden nie automatisch gelöscht.
              </CardDescription>
            </div>
            <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => refetchFiles()} title="Liste aktualisieren">
              <RefreshCw className={`h-4 w-4 ${filesLoading ? 'animate-spin' : ''}`} />
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {filesLoading ? <p className="text-sm text-muted-foreground px-4 pb-4">Lade…</p>
            : files.length === 0 ? <p className="text-sm text-muted-foreground px-4 pb-4">Keine Backup-Dateien gefunden.</p>
            : <div>{groups.map((g) => <BackupGroupSection key={g.key} group={g} onRestore={(f) => { setRestoreTarget(f); setRestoreSuccess(false); restoreDialogZuruecksetzen(); }} />)}</div>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Lokales Backup einspielen</CardTitle>
          <CardDescription className="text-xs">Stellt die Datenbank aus einer lokal gespeicherten Backup-Datei (.pgdump.gz) wieder her.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center gap-3 flex-wrap">
            <label htmlFor="backup-upload" className="cursor-pointer inline-flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-sm font-medium hover:bg-muted/50 transition-colors">
              <Upload className="h-4 w-4" />Datei auswählen
            </label>
            <input id="backup-upload" type="file" accept=".pgdump.gz,.gz" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) setUploadFile(f); e.target.value = ''; }} />
            {uploadFile && <span className="text-xs font-mono text-muted-foreground truncate max-w-[220px]">{uploadFile.name}</span>}
          </div>
          {uploadFile && (
            <Button variant="outline" size="sm" className="h-7 text-xs text-destructive border-destructive/30 hover:bg-destructive/5 hover:border-destructive/60" onClick={() => { setUploadRestoreSuccess(false); setUploadRestoreOpen(true); uploadDialogZuruecksetzen(); }}>
              <RotateCcw className="h-3 w-3 mr-1.5" />Wiederherstellen
            </Button>
          )}
        </CardContent>
      </Card>

      <Dialog open={!!restoreTarget} onOpenChange={(o) => { if (!o && !restoreMutation.isPending && (!restoreSuccess || restoreNeustart.zustand === 'zeitueberschritten')) { setRestoreTarget(null); restoreDialogZuruecksetzen(); } }}>
        {restoreSuccess ? (
          <RestoreNeustartInhalt neustart={restoreNeustart} />
        ) : (
          <><DialogTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0" />Datenbank wiederherstellen?</DialogTitle>
          <DialogDescription className="mt-2 space-y-2">
            <p>Backup <strong className="text-foreground font-mono text-xs">{restoreTarget?.name}</strong> einspielen.</p>
            {restoreTarget?.appVersion && <p>Erstellt mit App-Version <strong className="text-foreground">v{restoreTarget.appVersion}</strong>{restoreTarget.schemaFingerprint && <> · Schema {restoreTarget.schemaFingerprint.slice(0, 12)}</>}.</p>}
            {restoreTarget?.newerThanInstalled && <p className="rounded-md bg-amber-500/10 border border-amber-500/30 px-2.5 py-2 text-amber-700 dark:text-amber-300">Dieses Backup stammt aus einer neueren App-Version. Vor dem Restore sollte postbuch.net aktualisiert werden.</p>}
            {restoreTarget?.encrypted && <p>Das Backup ist verschlüsselt. Kennt diese Instanz seinen Schlüssel, wird es ohne Passworteingabe geöffnet.</p>}
            <p className="text-destructive/80 font-medium">Alle Daten nach diesem Backup gehen unwiederbringlich verloren.</p>
          </DialogDescription>
          <VorabSicherungBlock sicherung={restoreSicherung} gesperrt={restoreMutation.isPending} />
          {restorePasswortNoetig && <BackupPasswortFeld wert={restorePasswort} onChange={setRestorePasswort} gesperrt={restoreMutation.isPending} />}
          {restoreError && <p className="mt-3 text-sm text-destructive font-medium">{restoreError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setRestoreTarget(null); restoreDialogZuruecksetzen(); }} disabled={restoreMutation.isPending}>Abbrechen</Button>
            <Button variant="destructive" onClick={() => restoreMutation.mutate({ fileId: restoreTarget.id, ...restoreArgumente(restoreSicherung) })} disabled={restoreMutation.isPending || !restoreArgumente(restoreSicherung) || (restorePasswortNoetig && !restorePasswort)}>
              {restoreMutation.isPending
                ? 'Wiederherstellen…'
                : restoreArgumente(restoreSicherung)?.ohneVorabSicherung ? 'Ohne Sicherung wiederherstellen' : 'Jetzt wiederherstellen'}
            </Button>
          </DialogFooter></>
        )}
      </Dialog>

      <Dialog open={uploadRestoreOpen} onOpenChange={(o) => { if (!o && !uploadRestoreMutation.isPending && (!uploadRestoreSuccess || uploadNeustart.zustand === 'zeitueberschritten')) { setUploadRestoreOpen(false); uploadDialogZuruecksetzen(); } }}>
        {uploadRestoreSuccess ? (
          <RestoreNeustartInhalt neustart={uploadNeustart} />
        ) : (
          <><DialogTitle className="flex items-center gap-2"><AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0" />Datenbank wiederherstellen?</DialogTitle>
          <DialogDescription className="mt-2 space-y-2">
            <p>Lokale Datei <strong className="text-foreground font-mono text-xs">{uploadFile?.name}</strong> einspielen.</p>
            <p className="text-destructive/80 font-medium">Alle Daten nach diesem Backup gehen unwiederbringlich verloren.</p>
          </DialogDescription>
          <VorabSicherungBlock sicherung={uploadSicherung} gesperrt={uploadRestoreMutation.isPending} />
          {uploadPasswortNoetig && <BackupPasswortFeld wert={uploadPasswort} onChange={setUploadPasswort} gesperrt={uploadRestoreMutation.isPending} />}
          {uploadRestoreError && <p className="mt-3 text-sm text-destructive font-medium">{uploadRestoreError}</p>}
          <DialogFooter>
            <Button variant="outline" onClick={() => { setUploadRestoreOpen(false); uploadDialogZuruecksetzen(); }} disabled={uploadRestoreMutation.isPending}>Abbrechen</Button>
            <Button variant="destructive" onClick={() => uploadRestoreMutation.mutate(restoreArgumente(uploadSicherung))} disabled={uploadRestoreMutation.isPending || !restoreArgumente(uploadSicherung) || (uploadPasswortNoetig && !uploadPasswort)}>
              {uploadRestoreMutation.isPending
                ? 'Wird eingespielt…'
                : restoreArgumente(uploadSicherung)?.ohneVorabSicherung ? 'Ohne Sicherung wiederherstellen' : 'Jetzt wiederherstellen'}
            </Button>
          </DialogFooter></>
        )}
      </Dialog>

      <Dialog open={revealOffen} onOpenChange={(o) => { if (!o && !revealMutation.isPending) setRevealOffen(false); }}>
        <DialogTitle className="flex items-center gap-2">
          <Lock className="h-5 w-5 flex-shrink-0" />Backup-Passwort anzeigen
        </DialogTitle>
        <DialogDescription className="mt-2 space-y-2">
          <p>Zur Bestätigung bitte das Admin-Passwort erneut eingeben.</p>
        </DialogDescription>
        {!revealMutation.data?.passwort ? (
          <>
            <div className="mt-2">
              <Input
                type="password"
                value={revealAppPasswort}
                onChange={(e) => setRevealAppPasswort(e.target.value)}
                placeholder="Admin-Passwort"
                className="h-9 text-sm"
                autoComplete="current-password"
                onKeyDown={(e) => { if (e.key === 'Enter') revealMutation.mutate(revealAppPasswort); }}
              />
            </div>
            {revealMutation.isError && <p className="mt-2 text-sm text-destructive font-medium">{revealMutation.error?.message}</p>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setRevealOffen(false)} disabled={revealMutation.isPending}>Abbrechen</Button>
              <Button onClick={() => revealMutation.mutate(revealAppPasswort)} disabled={revealMutation.isPending || !revealAppPasswort}>
                {revealMutation.isPending ? 'Prüfen…' : 'Anzeigen'}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="mt-2 rounded-lg border border-border bg-muted/40 px-3 py-2.5 font-mono text-sm break-all select-all">
              {revealMutation.data.passwort}
            </div>
            <DialogFooter>
              <Button onClick={() => setRevealOffen(false)}>Schließen</Button>
            </DialogFooter>
          </>
        )}
      </Dialog>
    </div>
  );
}

function verkuerzeDateiname(name, maxLaenge = 30) {
  if (!name || name.length <= maxLaenge) return name || '(ohne Dateiname)';
  const rest = maxLaenge - 1;
  return `${name.slice(0, Math.ceil(rest * 0.6))}…${name.slice(name.length - Math.floor(rest * 0.4))}`;
}

// Zeigt die vom Dokumentumzug betroffenen Post-IDs mit (verkürztem) Dateinamen
// an. Vorher stand nach einem Fehler nur die Gesamtzahl ("Dokumentumzug mit
// 1 Fehler(n) beendet") ohne erkennbar zu machen, welches Dokument betroffen
// war. Der Kopieren-Button liefert bewusst die vollen, untrunkierten Namen.
function UmzugFehlerListe({ fehlerListe }) {
  const [kopiert, setKopiert] = useState(false);

  function kopieren() {
    const text = fehlerListe
      .map((f) => `${f.postid}\t${f.filename || '(ohne Dateiname)'}\t${f.message || ''}`)
      .join('\n');
    navigator.clipboard.writeText(text).then(() => {
      setKopiert(true);
      setTimeout(() => setKopiert(false), 2000);
    });
  }

  return (
    <div className="rounded-lg border border-destructive/30 bg-destructive/5">
      <div className="flex items-center justify-between px-3 py-1.5 border-b border-destructive/20">
        <span className="text-xs font-medium text-muted-foreground">Betroffene Dokumente ({fehlerListe.length})</span>
        <button
          onClick={kopieren}
          title={kopiert ? 'Kopiert!' : 'Vollständige Liste kopieren'}
          className="flex items-center gap-1 text-xs text-muted-foreground/70 hover:text-foreground transition-colors"
        >
          {kopiert ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
          {kopiert ? 'Kopiert' : 'Kopieren'}
        </button>
      </div>
      <div className="max-h-48 overflow-y-auto divide-y divide-destructive/10">
        {fehlerListe.map((f) => (
          <div key={f.postid} className="flex items-baseline gap-2 px-3 py-1 text-xs">
            <span className="font-mono text-muted-foreground flex-shrink-0">{f.postid}</span>
            <span className="font-mono truncate" title={f.filename || ''}>{verkuerzeDateiname(f.filename)}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// `backend` dient hier nur der Beschriftung: setupFolderStructure() läuft
// serverseitig ohnehin immer gegen das aktive Dateiablage-Backend. Vorher stand hier
// hart „in OneDrive" – auf einer Nextcloud-Instanz eine glatte Falschaussage.
function SetupWizardCard({ onDone, backend }) {
  const backendLabel = backend === 'nextcloud' ? 'WebDAV-Speicher' : 'OneDrive';
  // Der Root-Pfad wird NICHT geraten. Er kommt aus der Instanz; 'postbuch' ist
  // nur die Vorgabe, solange dort noch nichts eingerichtet ist.
  const wurzelQuery = useQuery({ queryKey: ['ablage-wurzel'], queryFn: () => api.onedrive.folderRoot(), retry: false });
  // Ist bereits ein Wurzelordner eingerichtet, legt diese Karte keine neue
  // Struktur mehr an, sondern verschiebt eine bestehende – das erfordert auf
  // jedem Weg (Einrichtungsassistent, Installer) ohnehin schon der Pflichtschritt
  // „Ordner". Nur ohne Ist-Zustand bleibt sie das, was der Name verspricht.
  const eingerichtet = !!wurzelQuery.data?.rootPath;
  const [rootPath, setRootPath] = useState('');
  const [results, setResults]   = useState(null);
  const [error, setError]       = useState('');
  const [warnung, setWarnung]   = useState(null);
  const [ordnerJobId, setOrdnerJobId] = useState(null);
  const [umzugJobId, setUmzugJobId]   = useState(null);
  const [umzugFehler, setUmzugFehler] = useState('');
  const [umzugFehlerListe, setUmzugFehlerListe] = useState(null);
  const running = !!ordnerJobId || !!umzugJobId;
  useEffect(() => {
    const w = wurzelQuery.data;
    if (w) setRootPath((alt) => alt || w.rootPath || 'postbuch');
  }, [wurzelQuery.data]);
  // Läuft bereits ein Setup-/Umzugs-Job im Hintergrund (z. B. nach einem
  // Seiten-Reload während eines laufenden Umzugs), Fortschrittsbalken und
  // Sperre sofort wiederherstellen statt den Button fälschlich freizugeben.
  useEffect(() => {
    let abgebrochen = false;
    api.jobs.list().then((res) => {
      if (abgebrochen) return;
      const aktiv = res?.active || [];
      const setup = aktiv.find((j) => j.type === 'storage-setup');
      const relocate = aktiv.find((j) => j.type === 'storage-relocate');
      if (setup) setOrdnerJobId(setup.id);
      if (relocate) setUmzugJobId(relocate.id);
    }).catch(() => {});
    return () => { abgebrochen = true; };
  }, []);
  async function runWizard(bestaetigt = false) {
    if (!rootPath.trim()) { setError('Root-Pfad darf nicht leer sein.'); return; }
    setError(''); setWarnung(null); setResults(null); setUmzugFehler(''); setUmzugFehlerListe(null);
    try {
      const res = await api.onedrive.setupWizard(rootPath.trim(), bestaetigt, true);
      setOrdnerJobId(res.jobId);
    } catch (e) {
      // Abweichender Wurzelordner ist eine Rückfrage, kein Fehler: der Lauf
      // würde den gesamten Dokumentenbestand umziehen.
      if (e?.payload?.code === 'WURZEL_ABWEICHUNG') setWarnung(e.payload); else setError(e.message);
    }
  }
  function onOrdnerDone(job) {
    setOrdnerJobId(null);
    if (job.status === 'done') {
      setResults(job.payload?.folders || []);
      onDone();
      const relocateJobId = job.payload?.relocateJobId;
      if (relocateJobId) setUmzugJobId(relocateJobId);
    } else {
      setError(job.errorMessage ?? job.error_message ?? 'Ordner anlegen fehlgeschlagen.');
    }
  }
  function onUmzugDone(job) {
    setUmzugJobId(null);
    if (job.status === 'done') {
      onDone();
    } else {
      setUmzugFehler(job.errorMessage ?? job.error_message ?? 'Dokumente umziehen fehlgeschlagen.');
      setUmzugFehlerListe(job.payload?.fehlerListe || null);
    }
  }
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          {eingerichtet ? <ArrowLeftRight className="h-5 w-5 text-primary" /> : <Wand2 className="h-5 w-5 text-primary" />}
          <CardTitle className="text-base">{eingerichtet ? 'Wurzelordner umziehen' : 'Setup-Assistent'}</CardTitle>
        </div>
        <CardDescription className="text-xs pt-1">
          {eingerichtet
            ? `Verschiebt den gesamten Dokumentenbestand unter einen anderen Root-Pfad in ${backendLabel}. Bereits vorhandene Ordner am Ziel werden nie überschrieben, nur gefunden; der bisherige Ordner bleibt unangetastet.`
            : `Erstellt alle benötigten Ordner unter einem Root-Pfad in ${backendLabel} und speichert die IDs. Bereits vorhandene Ordner werden nie überschrieben, nur gefunden.`}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2 items-end">
          <div className="flex-1 space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Root-Pfad (relativ zum {backend === 'nextcloud' ? 'WebDAV-Stammverzeichnis' : 'Drive-Root'})</label>
            <Input value={rootPath} onChange={(e) => { setRootPath(e.target.value); setWarnung(null); }} placeholder={wurzelQuery.isPending ? 'wird gelesen…' : 'postbuch'} className="h-8 text-sm font-mono" onKeyDown={(e) => { if (e.key === 'Enter') runWizard(); }} />
          </div>
          <Button size="sm" onClick={() => runWizard()} disabled={running || wurzelQuery.isPending} className="h-8">
            {running
              ? <><Spinner className="h-3.5 w-3.5 mr-1.5" />Läuft…</>
              : eingerichtet
                ? <><ArrowLeftRight className="h-3.5 w-3.5 mr-1.5" />Umziehen</>
                : <><Wand2 className="h-3.5 w-3.5 mr-1.5" />Ordner anlegen</>}
          </Button>
        </div>
        {error && <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2"><AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" /><span className="break-all">{error}</span></div>}
        <JobFortschritt jobId={ordnerJobId} titel="Ordnerstruktur anlegen" onDone={onOrdnerDone} />
        <JobFortschritt jobId={umzugJobId} titel="Dokumente umziehen" onDone={onUmzugDone} />
        {umzugFehler && <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2"><AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" /><span className="break-all">{umzugFehler}</span></div>}
        {umzugFehlerListe?.length > 0 && <UmzugFehlerListe fehlerListe={umzugFehlerListe} />}
        {warnung && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 space-y-2">
            <div className="flex items-start gap-2 text-sm"><AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5 text-amber-600 dark:text-amber-400" /><span>{warnung.error}</span></div>
            <p className="text-sm font-medium">Sollen die Daten wirklich dorthin umgezogen werden?</p>
            <div className="flex gap-2">
              <Button size="sm" className="h-7 text-xs" onClick={() => runWizard(true)} disabled={running}>Ja, Dateiablage umziehen</Button>
              <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => { setRootPath(warnung.bisher); setWarnung(null); }}>Abbrechen, bei „{warnung.bisher}“ bleiben</Button>
            </div>
          </div>
        )}
        {results && (
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">Ergebnis:</p>
            <div className="rounded-lg border border-border/60 divide-y divide-border/40">
              {results.map((r) => (
                <div key={r.folder} className="flex items-center gap-2 px-3 py-1.5">
                  {r.existed ? <RefreshCw className="h-3.5 w-3.5 text-amber-500 flex-shrink-0" /> : <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500 flex-shrink-0" />}
                  <span className="text-xs font-mono flex-1">{r.folder}</span>
                  <Badge variant={r.existed ? 'secondary' : 'default'} className="text-[10px]">{r.existed ? 'vorhanden' : 'neu'}</Badge>
                </div>
              ))}
            </div>
          </div>
        )}
        {results && !warnung && !ordnerJobId && !umzugJobId && !error && !umzugFehler && (
          <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4 flex-shrink-0" />
            <span>Ordnerstruktur und Dokumentumzug sind abgeschlossen.</span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Disaster Recovery Card ────────────────────────────────────────────────────

function DisasterRecoveryCard() {
  const qc = useQueryClient();
  const { data: status, refetch: refetchStatus } = useQuery({
    queryKey: ['dr', 'status'],
    queryFn: () => api.dr.status(),
    retry: false,
  });

  const [expanded, setExpanded] = useState(false);
  const [step, setStep] = useState('idle'); // idle | resolving | confirming | running | manual | done | error
  const [rootInput, setRootInput] = useState('');
  const [resolved, setResolved] = useState(null);
  const [resolveError, setResolveError] = useState('');
  const [sessionId, setSessionId] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [error, setError] = useState('');

  const fingerprintMutation = useMutation({
    mutationFn: () => api.dr.fingerprintRun(),
    onSuccess: () => {
      setTimeout(() => { qc.invalidateQueries({ queryKey: ['dr', 'status'] }); refetchStatus(); }, 1500);
    },
  });

  // Polling während Recovery
  const { data: session } = useQuery({
    queryKey: ['dr', 'session', sessionId],
    queryFn: () => api.dr.getSession(sessionId),
    enabled: !!sessionId,
    refetchInterval: (query) => {
      const s = query.state.data;
      if (!s) return 2000;
      if (s.status === 'scanning') return 2000;
      return false;
    },
  });

  const { data: job } = useQuery({
    queryKey: ['jobs', jobId],
    queryFn: () => api.jobs.get(jobId),
    enabled: !!jobId && step === 'running',
    refetchInterval: 1500,
  });

  // Wenn Recovery fertig, Status aktualisieren
  useEffect(() => {
    if (!session) return;
    if (session.status === 'awaiting-manual') setStep('manual');
    else if (session.status === 'done')        setStep('done');
    else if (session.status === 'error')       { setStep('error'); setError(session.error_message || 'Unbekannter Fehler'); }
    else if (session.status === 'cancelled')   setStep('done');
  }, [session?.status]);

  async function resolveRoot() {
    setResolveError('');
    setResolved(null);
    if (!rootInput.trim()) { setResolveError('Bitte Pfad oder Item-ID angeben.'); return; }
    setStep('resolving');
    try {
      const r = await api.dr.resolveRoot(rootInput.trim());
      setResolved(r);
      setStep('confirming');
    } catch (e) {
      setResolveError(e.message);
      setStep('idle');
    }
  }

  async function startRecovery() {
    setError('');
    setStep('running');
    try {
      const r = await api.dr.startRecovery(resolved.id, resolved.label);
      setSessionId(r.sessionId);
      setJobId(r.jobId);
    } catch (e) {
      setError(e.message);
      setStep('error');
    }
  }

  function reset() {
    setStep('idle');
    setRootInput('');
    setResolved(null);
    setResolveError('');
    setSessionId(null);
    setJobId(null);
    setError('');
    refetchStatus();
  }

  const stats   = session?.stats || {};
  const unmatched = Array.isArray(session?.unmatched) ? session.unmatched : [];
  const matchedTotal = (stats.matchedByHash || 0) + (stats.matchedByName || 0);
  const dbTotal = stats.postbuchTotal || 0;
  const progress = dbTotal > 0 ? Math.round((matchedTotal / dbTotal) * 100) : 0;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <LifeBuoy className="h-5 w-5 text-destructive" />
            <CardTitle className="text-base">Disaster Recovery</CardTitle>
          </div>
          <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setExpanded(!expanded)}>
            {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          </Button>
        </div>
        <CardDescription className="text-xs pt-1">
          Stellt Datei-Verknüpfungen wieder her, falls auf OneDrive ein externes Backup eingespielt wurde
          und sich dadurch alle File-IDs geändert haben.
        </CardDescription>
      </CardHeader>

      {expanded && (
        <CardContent className="space-y-4">
          {/* Fingerprint-Status */}
          <div className="rounded-lg border border-border/60 px-3 py-2.5 space-y-2">
            <div className="flex items-center gap-2 text-sm font-medium">
              <Fingerprint className="h-4 w-4 text-primary" />SHA256-Fingerabdrücke
            </div>
            {!status ? (
              <p className="text-xs text-muted-foreground">Lade…</p>
            ) : (
              <>
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">{status.withSha256} / {status.withOnedrive} Dokumente gehasht</span>
                  {status.missingSha256 > 0
                    ? <Badge variant="secondary" className="text-[10px]">{status.missingSha256} ausstehend</Badge>
                    : <Badge variant="default" className="text-[10px]">Vollständig</Badge>}
                </div>
                <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full bg-primary transition-all"
                    style={{ width: `${status.withOnedrive ? Math.round(status.withSha256 / status.withOnedrive * 100) : 0}%` }}
                  />
                </div>
                <div className="flex items-center gap-2 pt-1">
                  <Button size="sm" variant="outline" className="h-7 text-xs"
                    onClick={() => fingerprintMutation.mutate()}
                    disabled={fingerprintMutation.isPending}>
                    <RefreshCw className={`h-3 w-3 mr-1.5 ${fingerprintMutation.isPending ? 'animate-spin' : ''}`} />
                    Fingerprint-Sync
                  </Button>
                  <p className="text-[11px] text-muted-foreground">Läuft automatisch wöchentlich.</p>
                </div>
                {fingerprintMutation.isError && (
                  <p className="text-xs text-destructive">{fingerprintMutation.error?.message}</p>
                )}
              </>
            )}
          </div>

          {/* Recovery-Wizard */}
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 space-y-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
              <div className="text-xs text-amber-700 dark:text-amber-300">
                <p className="font-medium">Wiederherstellungs-Modus</p>
                <p className="mt-0.5">
                  Ist auf einer funktionierenden OneDrive unschädlich – korrekte Verknüpfungen
                  werden nicht verändert.
                </p>
              </div>
            </div>

            {step === 'idle' && (
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground">Stamm-Ordner (Pfad oder OneDrive Item-ID)</label>
                <div className="flex gap-2">
                  <Input
                    value={rootInput}
                    onChange={(e) => setRootInput(e.target.value)}
                    placeholder="postbuch"
                    className="h-8 text-sm font-mono"
                    onKeyDown={(e) => { if (e.key === 'Enter') resolveRoot(); }}
                  />
                  <Button size="sm" className="h-8" onClick={resolveRoot}>
                    <Search className="h-3.5 w-3.5 mr-1.5" />Auflösen
                  </Button>
                </div>
                {resolveError && (
                  <p className="text-xs text-destructive flex items-center gap-1">
                    <AlertCircle className="h-3.5 w-3.5" />{resolveError}
                  </p>
                )}
              </div>
            )}

            {step === 'resolving' && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Spinner className="h-4 w-4" />Pfad wird aufgelöst…
              </div>
            )}

            {step === 'confirming' && resolved && (
              <div className="space-y-2">
                <p className="text-xs">Stamm-Ordner: <span className="font-mono text-foreground">{resolved.label}</span></p>
                <p className="text-xs text-muted-foreground">
                  Es wird rekursiv über alle Dateien iteriert, jede heruntergeladen und gehasht.
                  Bei <strong>{status?.withSha256 || 0}</strong> Dokumenten mit SHA256 wird die
                  korrekte File-ID anhand des Hashs neu gesetzt.
                </p>
                <div className="flex items-center gap-2">
                  <Button size="sm" className="h-8" onClick={startRecovery}>
                    <Play className="h-3.5 w-3.5 mr-1.5" />Recovery starten
                  </Button>
                  <Button size="sm" variant="outline" className="h-8" onClick={reset}>Abbrechen</Button>
                </div>
              </div>
            )}

            {step === 'running' && (
              <div className="space-y-2">
                <p className="text-xs font-medium">Recovery läuft…</p>
                <div className="text-xs text-muted-foreground">
                  {job?.step_label || job?.stepLabel || 'Initialisierung…'}
                </div>
                {job && (job.total_steps || job.totalSteps) > 0 && (
                  <div className="h-1.5 w-full bg-muted rounded-full overflow-hidden">
                    <div
                      className="h-full bg-primary transition-all"
                      style={{ width: `${Math.min(100, Math.round((job.step / (job.total_steps || job.totalSteps)) * 100))}%` }}
                    />
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground">
                  Das Hashing aller Dateien kann je nach Anzahl mehrere Minuten dauern.
                </p>
              </div>
            )}

            {(step === 'manual' || step === 'done') && session && (
              <DRResults
                session={session}
                progress={progress}
                matchedTotal={matchedTotal}
                dbTotal={dbTotal}
                unmatched={unmatched}
                onRefresh={() => qc.invalidateQueries({ queryKey: ['dr', 'session', sessionId] })}
                onReset={reset}
              />
            )}

            {step === 'error' && (
              <div className="space-y-2">
                <p className="text-xs text-destructive flex items-center gap-1">
                  <AlertCircle className="h-3.5 w-3.5" />Recovery fehlgeschlagen: {error}
                </p>
                <Button size="sm" variant="outline" className="h-8" onClick={reset}>Zurücksetzen</Button>
              </div>
            )}
          </div>
        </CardContent>
      )}
    </Card>
  );
}

function DRResults({ session, progress, matchedTotal, dbTotal, unmatched, onRefresh, onReset }) {
  const stats = session.stats || {};
  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium">Wiederhergestellt</span>
          <span className="text-muted-foreground">{matchedTotal} / {dbTotal} ({progress}%)</span>
        </div>
        <div className="h-2 w-full bg-muted rounded-full overflow-hidden">
          <div className="h-full bg-emerald-500 transition-all" style={{ width: `${progress}%` }} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 text-xs">
        <div className="rounded border border-border/40 px-2 py-1.5">
          <div className="text-muted-foreground">via SHA256</div>
          <div className="font-medium text-base">{stats.matchedByHash ?? 0}</div>
        </div>
        <div className="rounded border border-border/40 px-2 py-1.5">
          <div className="text-muted-foreground">via Dateiname</div>
          <div className="font-medium text-base">{stats.matchedByName ?? 0}</div>
        </div>
        <div className="rounded border border-border/40 px-2 py-1.5">
          <div className="text-muted-foreground">unverändert</div>
          <div className="font-medium text-base">{stats.unchangedCorrect ?? 0}</div>
        </div>
        <div className="rounded border border-border/40 px-2 py-1.5">
          <div className="text-muted-foreground">extra Dateien</div>
          <div className="font-medium text-base">{stats.extras ?? 0}</div>
        </div>
      </div>

      {unmatched.length > 0 ? (
        <div className="space-y-2">
          <p className="text-xs font-medium">{unmatched.length} ungematchte postbuch.net-Einträge</p>
          <div className="rounded-lg border border-border/60 divide-y divide-border/40 max-h-96 overflow-y-auto">
            {unmatched.map(u => <UnmatchedRow key={u.postid} entry={u} sessionId={session.id} onResolved={onRefresh} />)}
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-sm text-emerald-600 dark:text-emerald-400">
          <CheckCircle className="h-4 w-4" />
          {stats.unmatched > 0
            ? 'Alle ungematchten Einträge wurden manuell aufgelöst.'
            : 'Alle Einträge wurden automatisch wiederhergestellt.'}
        </div>
      )}

      <div className="flex items-center gap-2 pt-1">
        <Button size="sm" variant="outline" className="h-8" onClick={onReset}>Schließen</Button>
      </div>
    </div>
  );
}

function UnmatchedRow({ entry, sessionId, onResolved }) {
  const [mode, setMode] = useState(null); // null | 'pick' | 'leave' | 'delete-confirm'
  const [search, setSearch] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function doSearch() {
    setSearching(true);
    setError('');
    try {
      const r = await api.dr.extrasSearch(sessionId, search);
      setResults(r);
    } catch (e) {
      setError(e.message);
    } finally {
      setSearching(false);
    }
  }

  async function pickFile(fileId) {
    setBusy(true); setError('');
    try {
      await api.dr.manualLink(sessionId, entry.postid, fileId);
      onResolved();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function leave() {
    setBusy(true); setError('');
    try {
      await api.dr.manualLeave(sessionId, entry.postid);
      onResolved();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  async function deleteEntry() {
    setBusy(true); setError('');
    try {
      await api.dr.manualDelete(sessionId, entry.postid);
      onResolved();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }

  return (
    <div className="px-3 py-2">
      <div className="flex items-center gap-2">
        <Link to={`/dokumente/${entry.postid}`} className="font-mono text-xs text-primary hover:underline">{entry.postid}</Link>
        <span className="text-xs text-muted-foreground truncate flex-1">{entry.onedrive_filename || '–'}</span>
        {!mode && (
          <>
            <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={() => { setMode('pick'); setResults([]); setSearch(entry.onedrive_filename || ''); }}>
              <Link2 className="h-3 w-3 mr-1" />Manuell verknüpfen
            </Button>
            <Button size="sm" variant="outline" className="h-6 text-[11px]" onClick={() => setMode('leave')}>
              <Unlink2 className="h-3 w-3 mr-1" />Unverlinkt
            </Button>
            <Button size="sm" variant="outline" className="h-6 text-[11px] text-destructive border-destructive/30" onClick={() => setMode('delete-confirm')}>
              <Trash2 className="h-3 w-3 mr-1" />Löschen
            </Button>
          </>
        )}
      </div>
      {entry.sha256 && (
        <p className="text-[10px] text-muted-foreground font-mono mt-0.5 truncate">SHA256: {entry.sha256}</p>
      )}

      {mode === 'pick' && (
        <div className="mt-2 space-y-2">
          <div className="flex gap-2">
            <Input value={search} onChange={e => setSearch(e.target.value)} placeholder="Datei suchen…" className="h-7 text-xs"
              onKeyDown={e => { if (e.key === 'Enter') doSearch(); }} />
            <Button size="sm" className="h-7" onClick={doSearch} disabled={searching}>
              {searching ? <Spinner className="h-3.5 w-3.5" /> : <Search className="h-3.5 w-3.5" />}
            </Button>
            <Button size="sm" variant="outline" className="h-7" onClick={() => setMode(null)}>Zurück</Button>
          </div>
          {results.length > 0 && (
            <div className="rounded border border-border/40 divide-y divide-border/30 max-h-48 overflow-y-auto">
              {results.map(f => (
                <button key={f.id} type="button" onClick={() => pickFile(f.id)} disabled={busy}
                  className="w-full flex items-center gap-2 px-2 py-1.5 text-left hover:bg-muted/50 transition-colors disabled:opacity-50">
                  <Link2 className="h-3 w-3 text-primary flex-shrink-0" />
                  <span className="text-xs font-mono truncate">{f.name}</span>
                </button>
              ))}
            </div>
          )}
          {!searching && results.length === 0 && search && (
            <p className="text-[11px] text-muted-foreground">Keine extras-Dateien gefunden.</p>
          )}
        </div>
      )}

      {mode === 'leave' && (
        <div className="mt-2 space-y-2">
          <p className="text-xs">postbuch.net-Eintrag bleibt erhalten, aber ohne OneDrive-Verknüpfung.</p>
          <div className="flex gap-2">
            <Button size="sm" className="h-7" onClick={leave} disabled={busy}>Bestätigen</Button>
            <Button size="sm" variant="outline" className="h-7" onClick={() => setMode(null)}>Abbrechen</Button>
          </div>
        </div>
      )}

      {mode === 'delete-confirm' && (
        <div className="mt-2 space-y-2 rounded bg-destructive/5 border border-destructive/30 px-2 py-1.5">
          <p className="text-xs text-destructive flex items-center gap-1.5">
            <AlertTriangle className="h-3.5 w-3.5" />postbuch.net-Eintrag <strong>{entry.postid}</strong> unwiderruflich löschen?
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="destructive" className="h-7" onClick={deleteEntry} disabled={busy}>
              {busy ? 'Lösche…' : 'Endgültig löschen'}
            </Button>
            <Button size="sm" variant="outline" className="h-7" onClick={() => setMode(null)}>Abbrechen</Button>
          </div>
        </div>
      )}

      {error && <p className="text-[11px] text-destructive mt-1">{error}</p>}
    </div>
  );
}

// Anzeigename des aktiven Dateiablage-Backends. Der interne Backend-Name bleibt
// 'nextcloud' (ein Adapter für die ganze ownCloud-WebDAV-Familie), im UI führt
// aber der Oberbegriff – der Adapter spricht generisches oc:fileid-WebDAV.
const ABLAGE_ANZEIGE = { onedrive: 'OneDrive', nextcloud: 'WebDAV-Speicher' };
// Die drei geläufigsten oc:fileid-fähigen WebDAV-Dienste (Nextcloud & ownCloud
// gegen echte Server verifiziert, MagentaCLOUD ist Nextcloud-basiert).
const WEBDAV_BEISPIELE = 'Nextcloud, ownCloud, MagentaCLOUD';

/**
 * Prominente Kopf-Karte des Dateiablage-Tabs: zeigt unübersehbar, welche Dateiablage
 * gerade aktiv ist, und bietet den Umzug auf die jeweils andere klar an – kein
 * versteckter „ausprobieren"-Link mehr, sondern ein echtes Angebot.
 */
/**
 * Zeigt eine Warn-Karte, wenn neben der aktiven Dateiablage noch eine zweite,
 * inaktive Backend-Verbindung besteht – typischerweise ein Rest nach einem
 * Umzug, dessen Aufräumen übersprungen oder dessen alte Verbindung nicht mit
 * getrennt wurde. Bewusst nicht auf den Migrationsassistenten beschränkt:
 * eine übrig gebliebene Verbindung soll immer auffallen, ganz oben in
 * Einstellungen → Dateiablage.
 */
function InaktiveVerbindungWarnung({ backend }) {
  const qc = useQueryClient();
  const { data: ncStatus } = useQuery({ queryKey: ['nextcloud-status'], queryFn: () => api.nextcloud.status(), retry: false });
  const { data: odStatus } = useQuery({ queryKey: ['onedrive-status'], queryFn: () => api.onedrive.status(), retry: false });
  const inaktivId = backend === 'nextcloud' ? 'onedrive' : 'nextcloud';
  const inaktivVerbunden = inaktivId === 'nextcloud' ? !!ncStatus?.connected : !!odStatus?.connected;
  const disconnectMutation = useMutation({
    mutationFn: () => (inaktivId === 'nextcloud' ? api.nextcloud.disconnect() : api.onedrive.disconnect()),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['nextcloud-status'] });
      qc.invalidateQueries({ queryKey: ['onedrive-status'] });
      qc.invalidateQueries({ queryKey: ['settings'] });
    },
  });

  if (!inaktivVerbunden) return null;
  const label = ABLAGE_ANZEIGE[inaktivId];
  return (
    <div className="space-y-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3.5 py-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2 text-sm">
          <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600 mt-0.5" />
          <span>
            Neben der aktiven Dateiablage ist noch eine ungenutzte Verbindung zu <span className="font-medium">{label}</span> hinterlegt.
            Wird sie nicht mehr gebraucht, kann sie getrennt werden.
          </span>
        </div>
        <Button size="sm" variant="outline" className="flex-shrink-0" onClick={() => disconnectMutation.mutate()} disabled={disconnectMutation.isPending}>
          {disconnectMutation.isPending ? <Spinner className="h-3.5 w-3.5 mr-1.5" /> : <Unlink2 className="h-3.5 w-3.5 mr-1.5" />}
          Verbindung zu {label} trennen
        </Button>
      </div>
      {disconnectMutation.isError && <p className="text-xs text-destructive pl-6">{disconnectMutation.error?.message}</p>}
    </div>
  );
}

// Ablagestruktur: zwei Vorlagen oder bis zu vier frei gewählte Ebenen.
// Umschalten und Umzug sind untrennbar – das Backend startet mit dem Wechsel
// den Gesamtumzug. Ein erneuter Klick auf die aktive Struktur setzt einen
// abgebrochenen Umzug fort. Eine neue Wahl während eines Umzugs bricht ihn ab
// und ersetzt ihn durch den Umzug in die neue Struktur.
const ABLAGE_EBENEN = {
  person: 'Person',
  lebensbereich: 'Lebensbereich',
  dokumentart: 'Dokumentart',
  jahr: 'Jahr',
  richtung: 'Richtung',
};
const ABLAGE_EBENEN_MAX = 4;
// Bezeichnung der Ordner einer Ebene in der Übersicht der Ordnerstruktur.
const ABLAGE_EBENEN_ORDNER = {
  person: 'Personenordner',
  dokumentart: 'Dokumentartordner',
  jahr: 'Jahresordner',
  richtung: 'Richtungsordner',
};
const ABLAGE_STRUKTUREN = {
  lxd: { titel: 'Nach Lebensbereich', ebenen: ['lebensbereich', 'dokumentart'] },
  person_lxd: { titel: 'Nach Person', ebenen: ['person', 'lebensbereich', 'dokumentart'] },
  benutzerdefiniert: { titel: 'Benutzerdefiniert' },
};
const ablagePfad = (ebenen) => ebenen.map((e) => ABLAGE_EBENEN[e]).join(' / ');
const gleicheEbenen = (a, b) => a.length === b.length && a.every((e, i) => e === b[i]);
const ABLAGE_PERSON_QUELLEN = {
  adressat: { titel: 'Adressat', text: 'An wen das Schreiben gerichtet ist.' },
  behandelt: { titel: 'Behandelte Person bzw. Tier', text: 'Bei Arztrechnungen, Arztberichten und Erstattungsbescheiden.' },
};

/** Wer bei Ablage nach Person den Personenordner bestimmt. */
function PersonQuelleAuswahl({ wert, onChange, disabled }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">Personenordner richten sich nach</p>
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Personenordner richten sich nach">
        {Object.entries(ABLAGE_PERSON_QUELLEN).map(([id, q]) => (
          <button
            key={id} type="button" role="radio" aria-checked={wert === id}
            disabled={disabled}
            onClick={() => onChange(id)}
            className={`rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-60 ${wert === id ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'}`}
          >
            <span className="text-sm font-medium">{q.titel}</span>
            <p className="mt-0.5 text-[11px] text-muted-foreground">{q.text}</p>
          </button>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Nennt ein Dokument keine eindeutige behandelte Person, etwa ein Erstattungsbescheid für mehrere Personen, zählt der Adressat.
      </p>
    </div>
  );
}

/**
 * Bis zu vier Ebenen, sukzessive: Ebene n+1 ist erst wählbar, wenn Ebene n
 * besetzt ist, und bietet nur Ebenen an, die weiter oben noch frei sind.
 */
function AblageEbenenAuswahl({ ebenen, onChange, disabled }) {
  function setze(index, wert) {
    // Eine geleerte oder geänderte Ebene verwirft alles darunter, sofern es
    // sonst doppelt belegt wäre bzw. ohne Vorebene in der Luft hinge.
    const neu = ebenen.slice(0, index);
    if (wert) {
      neu.push(wert);
      for (const e of ebenen.slice(index + 1)) if (!neu.includes(e)) neu.push(e);
    }
    onChange(neu);
  }
  return (
    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
      {Array.from({ length: ABLAGE_EBENEN_MAX }, (_, i) => {
        const gesperrt = disabled || i > ebenen.length;
        const vorher = ebenen.slice(0, i);
        return (
          <div key={i} className="space-y-1">
            <label htmlFor={`ablage-ebene-${i}`} className={`text-xs font-medium ${gesperrt ? 'text-muted-foreground/60' : 'text-muted-foreground'}`}>
              {i + 1}. Ebene{i === 0 ? '' : ' (optional)'}
            </label>
            <Select
              id={`ablage-ebene-${i}`}
              value={ebenen[i] || ''}
              disabled={gesperrt}
              onChange={(e) => setze(i, e.target.value)}
            >
              {i === 0
                ? <option value="" disabled>Bitte wählen</option>
                : <option value="">(nicht besetzt)</option>}
              {Object.entries(ABLAGE_EBENEN)
                .filter(([id]) => !vorher.includes(id))
                .map(([id, label]) => <option key={id} value={id}>{label}</option>)}
            </Select>
          </div>
        );
      })}
    </div>
  );
}

function AblageStrukturCard({ backendLabel, onDone }) {
  const qc = useQueryClient();
  const { data, isPending } = useQuery({
    queryKey: ['ablage-struktur'],
    queryFn: () => api.settings.ablageStruktur(),
    retry: false,
  });
  const aktuell = data?.struktur || 'lxd';
  const aktuelleEbenen = data?.ebenen || ABLAGE_STRUKTUREN.lxd.ebenen;
  const aktuellePersonQuelle = data?.personQuelle || 'adressat';
  // ziel: { struktur, ebenen, personQuelle } für den Bestätigungsdialog
  const [ziel, setZiel] = useState(null);
  // Entwurf der eigenen Ebenen; null = Auswahl zugeklappt
  const [entwurf, setEntwurf] = useState(null);
  const [jobId, setJobId] = useState(null);
  const [fehler, setFehler] = useState('');
  const [kollisionen, setKollisionen] = useState(null);
  const [fehlerListe, setFehlerListe] = useState(null);
  const [ergebnis, setErgebnis] = useState(null);

  // Laufenden Umzug finden: nach einem Reload oder wenn er aus einem anderen
  // Fenster heraus ersetzt wurde.
  const findeLaufendenUmzug = useCallback(() => api.jobs.list()
    .then((res) => (res?.active || []).find((j) => j.type === 'storage-relocate')?.id || null)
    .catch(() => null), []);

  useEffect(() => {
    if (!data?.umzugAktiv) return undefined;
    let abgebrochen = false;
    findeLaufendenUmzug().then((id) => { if (!abgebrochen && id) setJobId(id); });
    return () => { abgebrochen = true; };
  }, [data?.umzugAktiv, findeLaufendenUmzug]);

  const starten = useMutation({
    mutationFn: ({ struktur, ebenen, personQuelle }) => api.settings.setAblageStruktur(struktur, ebenen, personQuelle),
    onMutate: () => { setFehler(''); setKollisionen(null); setFehlerListe(null); setErgebnis(null); },
    onSuccess: (res) => {
      setZiel(null);
      setEntwurf(null);
      setJobId(res.jobId);
      qc.invalidateQueries({ queryKey: ['ablage-struktur'] });
    },
    onError: (err) => {
      setZiel(null);
      setFehler(err.message);
      if (err?.payload?.code === 'KURZNAME_KOLLISION') setKollisionen(err.payload.kollisionen || []);
    },
  });

  function onUmzugDone(job) {
    setJobId(null);
    qc.invalidateQueries({ queryKey: ['ablage-struktur'] });
    if (job.status === 'cancelled' && job.payload?.ersetzt) {
      // Durch eine neuere Strukturwahl ersetzt: deren Umzug weiterverfolgen.
      findeLaufendenUmzug().then((id) => { if (id) setJobId(id); });
      return;
    }
    if (job.status === 'done') {
      setErgebnis(job.payload?.aufraeumen || {});
      onDone?.();
    } else {
      setFehler(job.errorMessage ?? job.error_message ?? 'Umzug fehlgeschlagen.');
      setFehlerListe(job.payload?.fehlerListe || null);
    }
  }

  function waehle(id) {
    if (id !== 'benutzerdefiniert') {
      // Die gerade umziehende Struktur noch einmal zu wählen, brächte nichts.
      if (laeuft && id === aktuell) return;
      setEntwurf(null);
      setZiel({ struktur: id, ebenen: ABLAGE_STRUKTUREN[id].ebenen, personQuelle: aktuellePersonQuelle });
      return;
    }
    if (entwurf) return;
    // Ohne gespeicherte eigene Folge leer starten: „Bitte wählen“, Ebenen 2–4 gesperrt.
    setEntwurf(aktuell === 'benutzerdefiniert' ? aktuelleEbenen : (data?.benutzerEbenen || []));
  }

  const laeuft = !!jobId || !!data?.umzugAktiv;
  const entwurfAktiv = entwurf && gleicheEbenen(entwurf, aktuelleEbenen);
  const zielIstAktuell = ziel && gleicheEbenen(ziel.ebenen, aktuelleEbenen) && ziel.personQuelle === aktuellePersonQuelle;
  const zielPfad = ziel ? ablagePfad(ziel.ebenen) : '';

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <FolderTree className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">Ablagestruktur</CardTitle>
        </div>
        <CardDescription className="text-xs pt-1">
          Legt fest, wie postbuch.net die Dokumentordner in {backendLabel} gliedert. Dokumente ohne zugeordnete Person liegen bei der Ablage nach Person im Ordner „Gemeinsam“, Dokumente ohne Briefdatum bei der Ablage nach Jahr im Ordner „Ohne Datum“.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-2 sm:grid-cols-3">
          {Object.entries(ABLAGE_STRUKTUREN).map(([id, s]) => {
            const pfad = id === 'benutzerdefiniert'
              ? (aktuell === id ? ablagePfad(aktuelleEbenen) : 'bis zu 4 Ebenen frei wählen')
              : ablagePfad(s.ebenen);
            const markiert = aktuell === id || (id === 'benutzerdefiniert' && !!entwurf);
            return (
              <button
                key={id} type="button"
                disabled={starten.isPending || isPending}
                onClick={() => waehle(id)}
                aria-expanded={id === 'benutzerdefiniert' ? !!entwurf : undefined}
                className={`rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-60 ${markiert ? 'border-primary bg-primary/5' : 'hover:bg-muted/50'}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-sm font-medium">{s.titel}</span>
                  {aktuell === id && <Badge variant="default" className="text-[10px]">aktiv</Badge>}
                </div>
                <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">{pfad}</p>
              </button>
            );
          })}
        </div>
        {entwurf && (
          <div className="rounded-lg border px-3 py-3 space-y-3">
            <AblageEbenenAuswahl ebenen={entwurf} onChange={setEntwurf} disabled={starten.isPending} />
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <p className="font-mono text-[11px] text-muted-foreground">
                {entwurf.length ? `${ablagePfad(entwurf)} / Dokument` : 'Mindestens die erste Ebene wählen.'}
              </p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => setEntwurf(null)} disabled={starten.isPending}>Abbrechen</Button>
                <Button
                  size="sm"
                  disabled={starten.isPending || entwurf.length === 0 || (laeuft && entwurfAktiv)}
                  onClick={() => setZiel({ struktur: 'benutzerdefiniert', ebenen: entwurf, personQuelle: aktuellePersonQuelle })}
                >
                  {entwurfAktiv ? 'Speichern und Dateien umziehen' : 'Übernehmen'}
                </Button>
              </div>
            </div>
          </div>
        )}
        {aktuelleEbenen.includes('person') && (
          <PersonQuelleAuswahl
            wert={aktuellePersonQuelle}
            disabled={starten.isPending || isPending}
            onChange={(personQuelle) => {
              if (personQuelle !== aktuellePersonQuelle) setZiel({ struktur: aktuell, ebenen: aktuelleEbenen, personQuelle });
            }}
          />
        )}
        <JobFortschritt jobId={jobId} titel="Dokumente in neue Ablagestruktur verschieben" onDone={onUmzugDone} />
        {fehler && <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2"><AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" /><span>{fehler}</span></div>}
        {kollisionen?.length > 0 && (
          <ul className="rounded-lg border px-3 py-2 text-xs space-y-1">
            {kollisionen.map((k) => <li key={k.kurzname}><span className="font-mono">{k.kurzname}</span> – {k.grund}</li>)}
          </ul>
        )}
        {fehlerListe?.length > 0 && <UmzugFehlerListe fehlerListe={fehlerListe} />}
        {ergebnis && (
          <Testergebnis status={ergebnis.kept > 0 ? 'info' : 'erfolg'}>
            Umzug abgeschlossen.{ergebnis.deleted > 0 ? ` ${ergebnis.deleted} leere Ordner der bisherigen Struktur entfernt.` : ''}
            {ergebnis.kept > 0 ? ` ${ergebnis.kept} Ordner enthalten fremde Dateien und bleiben stehen.` : ''}
          </Testergebnis>
        )}
      </CardContent>

      <Dialog open={!!ziel} onOpenChange={(offen) => { if (!offen && !starten.isPending) setZiel(null); }}>
        <DialogTitle>{zielIstAktuell ? 'Speichern und Dateien umziehen?' : 'Ablagestruktur umstellen?'}</DialogTitle>
        <DialogDescription>
          {zielIstAktuell
            ? 'Die Struktur ist bereits aktiv. postbuch.net prüft alle Dokumente und verschiebt jene, die noch nicht am richtigen Ort liegen.'
            : `Alle Dokumente werden nach „${zielPfad}“ verschoben. Neue Dokumente landen sofort in der neuen Struktur. Leere Ordner der bisherigen Struktur werden danach entfernt.`}
        </DialogDescription>
        {ziel?.ebenen.includes('person') && (
          <PersonQuelleAuswahl
            wert={ziel.personQuelle}
            disabled={starten.isPending}
            onChange={(personQuelle) => setZiel({ ...ziel, personQuelle })}
          />
        )}
        {laeuft && !zielIstAktuell && (
          <p className="text-sm font-medium">
            Der laufende Umzug wird nach dem aktuellen Dokument abgebrochen und durch den Umzug in die neue Struktur ersetzt.
          </p>
        )}
        <p className="text-sm text-muted-foreground">
          Jede Datei wird einzeln verschoben. Das kann bei großen Beständen einige Zeit dauern und erzeugt bei Sync-Programmen auf angeschlossenen Rechnern entsprechend viel Abgleich. Ein unterbrochener Umzug lässt sich jederzeit fortsetzen.
        </p>
        <DialogFooter>
          <Button variant="outline" onClick={() => setZiel(null)} disabled={starten.isPending}>Abbrechen</Button>
          <Button onClick={() => starten.mutate(ziel)} disabled={starten.isPending}>
            {starten.isPending ? <><Spinner className="h-3.5 w-3.5 mr-1.5" />Startet…</> : zielIstAktuell ? 'Fortsetzen' : 'Umstellen'}
          </Button>
        </DialogFooter>
      </Dialog>
    </Card>
  );
}

function AktiveAblageCard({ backend, onUmziehen }) {
  const istOneDrive = backend !== 'nextcloud';
  const aktivLabel = ABLAGE_ANZEIGE[istOneDrive ? 'onedrive' : 'nextcloud'];
  const AktivIcon = istOneDrive ? Cloud : Server;
  return (
    <Card className="border-primary/30 bg-gradient-to-br from-primary/[0.07] to-transparent">
      <CardHeader className="pb-3">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10">
            <AktivIcon className="h-5 w-5 text-primary" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <CardTitle className="text-base">Aktive Dateiablage: {aktivLabel}</CardTitle>
              <Badge className="text-[10px]">aktiv</Badge>
            </div>
            <CardDescription className="text-xs pt-0.5">
              Alle Dokumente von postbuch.net werden derzeit in <span className="font-medium text-foreground">{aktivLabel}</span> gespeichert.
              Die Verbindungs­einstellungen weiter unten gehören zu {aktivLabel}.
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      <CardContent>
        <div className="rounded-lg border border-border/60 bg-background/70 px-3.5 py-3 flex items-center justify-between gap-3 flex-wrap">
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium">
              {istOneDrive ? 'Lieber deinen eigenen Speicher nutzen?' : 'Wechsel zu OneDrive?'}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {istOneDrive
                ? <>postbuch.net kann seine Dokumente stattdessen in deinem eigenen <span className="font-medium text-foreground">WebDAV-Speicher</span> ablegen ({WEBDAV_BEISPIELE}) – dein Server, deine Daten. Der Umzug kopiert alles hinüber; die Originale in OneDrive bleiben unangetastet.</>
                : <>postbuch.net kann seine Dokumente stattdessen in OneDrive ablegen. Der Umzug kopiert alles hinüber; die Originale bleiben unangetastet.</>}
            </p>
          </div>
          <Button size="sm" className="flex-shrink-0" onClick={onUmziehen}>
            <ArrowLeftRight className="h-3.5 w-3.5 mr-1.5" />
            {istOneDrive ? 'Auf WebDAV-Speicher umziehen' : 'Auf OneDrive umziehen'}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * AblageTab – früher „OneDrive". Polling, Ordner-Zuordnung,
 * Ordner-Initialisierung und Disaster-Recovery sind seit Phase 2
 * backend-agnostisch; nur die Verbindungskarten sind backendspezifisch.
 *
 * Aufbau seit dem Migrationsassistenten (AblageUmzugPage): ganz oben die
 * AktiveAblageCard (welche Dateiablage ist aktiv + Umzug-Angebot), dann die
 * Einrichtung der aktiven Dateiablage, darunter die backend-agnostischen Karten.
 * Die ANDERE Dateiablage verbinden, den Trockenlauf sehen, kopieren, umschalten
 * und aufräumen passiert nicht mehr hier, sondern vollständig im
 * Migrationsassistenten unter /ablage-umzug – der Umzug-Knopf oben navigiert
 * dorthin, statt Karten unten aufklappen zu lassen.
 */
// Manueller Scan, ob mit der Dateiablage verknüpfte Dateien dort noch existieren.
// Nur ein bestätigter 404 der Dateiablage löst pro Dokument die Verknüpfung, siehe
// service/storage-missing.js — eine vorübergehende Störung der Dateiablage darf
// niemals fälschlich Dokumente als fehlend markieren.
function FehlendeDateienScanCard() {
  const navigate = useNavigate();
  const [jobId, setJobId] = useState(null);
  const [ergebnis, setErgebnis] = useState(null);
  const [fehler, setFehler] = useState('');

  async function starteScan() {
    setFehler(''); setErgebnis(null);
    try {
      const res = await api.onedrive.scanMissing();
      setJobId(res.jobId);
    } catch (e) {
      setFehler(e.message);
    }
  }

  function onDone(job) {
    setJobId(null);
    if (job.status === 'done') {
      setErgebnis(job.payload || null);
    } else {
      setFehler(job.errorMessage ?? job.error_message ?? 'Scan fehlgeschlagen.');
    }
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Search className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">Dateiablage auf fehlende Dateien prüfen</CardTitle>
        </div>
        <CardDescription className="text-xs pt-1">
          Prüft für jedes Dokument mit Dateiablage-Verknüpfung, ob die Datei dort noch existiert.
          Nur eine bestätigte „Datei nicht gefunden“-Antwort der Dateiablage löst die Verknüpfung.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <Button size="sm" onClick={starteScan} disabled={!!jobId} className="h-8">
          {jobId
            ? <><Spinner className="h-3.5 w-3.5 mr-1.5" />Läuft…</>
            : <><Search className="h-3.5 w-3.5 mr-1.5" />Scan starten</>}
        </Button>
        {fehler && <div className="flex items-start gap-2 text-sm text-destructive bg-destructive/10 rounded-lg px-3 py-2"><AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" /><span className="break-all">{fehler}</span></div>}
        <JobFortschritt jobId={jobId} titel="Dateiablage wird geprüft" onDone={onDone} />
        {ergebnis && (
          <div className="flex items-center gap-2 text-sm flex-wrap">
            {ergebnis.missing > 0
              ? <AlertCircle className="h-4 w-4 flex-shrink-0 text-amber-500" />
              : <CheckCircle2 className="h-4 w-4 flex-shrink-0 text-emerald-500" />}
            <span>
              {ergebnis.checked} von {ergebnis.total} Dokument(en) geprüft, {ergebnis.missing} als fehlend markiert
              {ergebnis.errors > 0 ? `, ${ergebnis.errors} übersprungen (kein bestätigter Fehler)` : ''}.
            </span>
            {ergebnis.missing > 0 && (
              <Button size="sm" variant="outline" className="h-7 text-xs ml-auto" onClick={() => navigate('/postbuch?fehlt_in_ablage=true')}>
                Anzeigen
              </Button>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AblageTab({ settings, isLoading: settingsLoading, onRefresh }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  // Ordner-IDs liegen je Dateiablage-Backend getrennt in storage_folders
  const backend = settings?.storage_backend?.value || 'onedrive';
  const folders = settings?.storage_folders?.value?.[backend] || {};
  const pollingCfg = settings?.onedrive_polling?.value || {};
  const { data: taxonomie } = useQuery({
    queryKey: ['taxonomie'],
    queryFn: () => api.taxonomie.get(),
    staleTime: 5 * 60 * 1000,
  });
  const aktiveLebensbereiche = (taxonomie?.lebensbereich || []).filter((x) => x.aktiv);
  const systemOrdnerAnzahl = SYSTEM_FOLDER_KEYS.filter((key) => folders[key]).length;
  const lebensbereichOrdnerAnzahl = aktiveLebensbereiche.filter((x) => folders[x.code]).length;
  // Erste Ordnerebene der aktiven Ablagestruktur und ihre bereits angelegten Ordner.
  const ersteEbene = settings?.ablage_struktur?.value === 'person_lxd' ? 'person'
    : settings?.ablage_struktur?.value === 'benutzerdefiniert' && Array.isArray(settings?.ablage_ebenen?.value)
      ? settings.ablage_ebenen.value[0] : 'lebensbereich';
  const dokumentartCodes = new Set((taxonomie?.dokumentart || []).map((x) => x.code));
  const ersteEbeneTest = {
    person: (k) => k.startsWith('@'),
    jahr: (k) => k.startsWith('jahr:'),
    richtung: (k) => k.startsWith('richtung:'),
    dokumentart: (k) => dokumentartCodes.has(k),
  }[ersteEbene];
  const ersteEbeneAnzahl = ersteEbeneTest
    ? Object.keys(folders).filter((k) => !k.includes('/') && ersteEbeneTest(k)).length : 0;
  const wurzelEingerichtet = !!folders.inbox;

  const [pollEnabled,  setPollEnabled]  = useState(null);
  const [pollInterval, setPollInterval] = useState(null);

  const currentPollEnabled  = pollEnabled  !== null ? pollEnabled  : (pollingCfg.enabled     ?? false);
  const currentPollInterval = pollInterval !== null ? pollInterval : (pollingCfg.intervalSec  ?? 60);

  const [pollSaved, setPollSaved] = useState(false);
  const pollMutation = useMutation({
    mutationFn: (v) => api.settings.update('onedrive_polling', v),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['settings'] }); setPollEnabled(null); setPollInterval(null); setPollSaved(true); setTimeout(() => setPollSaved(false), 3000); },
  });

  const nextcloudAktiv = backend === 'nextcloud';

  return (
    <div className="space-y-6">
      <InaktiveVerbindungWarnung backend={backend} />
      <AktiveAblageCard backend={backend} onUmziehen={() => navigate('/ablage-umzug/ueberblick')} />

      {nextcloudAktiv
        ? <NextcloudCard />
        : <OneDriveSection settings={settings} onSaved={onRefresh} />}

      {/* Poll interval */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Automatisches Polling</CardTitle>
          <CardDescription className="text-xs">Wie oft der _inbox-Ordner auf neue Dokumente geprüft wird.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium">Polling aktiv</p>
              <p className="text-xs text-muted-foreground mt-0.5">{currentPollEnabled ? 'Aktiviert' : 'Deaktiviert'}</p>
            </div>
            <button type="button" onClick={() => setPollEnabled(!currentPollEnabled)} className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${currentPollEnabled ? 'bg-primary' : 'bg-muted'}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${currentPollEnabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Intervall (Sekunden)</label>
            <Input type="number" min="10" max="3600" value={currentPollInterval} onChange={(e) => setPollInterval(Number(e.target.value))} className="h-9 w-32 text-sm" />
            <p className="text-xs text-muted-foreground">Empfohlen: 30–120 Sekunden. Minimum: 10 s.</p>
          </div>
          {pollMutation.isError && <p className="text-sm text-destructive">{pollMutation.error?.message}</p>}
          <div className="flex items-center gap-3">
            <Button size="sm" onClick={() => pollMutation.mutate({ enabled: currentPollEnabled, intervalSec: Math.max(10, currentPollInterval) })} disabled={pollMutation.isPending}>
              {pollMutation.isPending ? 'Speichern…' : 'Speichern'}
            </Button>
            {pollSaved && <span className="text-xs text-emerald-600 flex items-center gap-1"><CheckCircle className="h-3.5 w-3.5" />Gespeichert</span>}
          </div>
        </CardContent>
      </Card>

      {settingsLoading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-4"><Spinner className="h-4 w-4" />Einstellungen werden geladen…</div>
      ) : (
        <Card>
          <CardHeader className="pb-3">
            <div className="flex items-center justify-between gap-2">
              <div className="flex items-center gap-2"><FolderOpen className="h-5 w-5 text-primary" /><CardTitle className="text-base">Ordnerstruktur</CardTitle></div>
              <Badge variant={wurzelEingerichtet ? 'default' : 'secondary'}>{wurzelEingerichtet ? 'eingerichtet' : 'nicht eingerichtet'}</Badge>
            </div>
            <CardDescription className="text-xs pt-1">Nur der Wurzelordner wird konfiguriert. System-, Lebensbereich- und Dokumentart-Ordner verwaltet postbuch.net automatisch.</CardDescription>
          </CardHeader>
          <CardContent className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <div className="rounded-md border px-3 py-2"><p className="text-xs text-muted-foreground">Wurzel</p><p className="text-sm font-medium">{wurzelEingerichtet ? 'gesetzt' : 'offen'}</p></div>
            <div className="rounded-md border px-3 py-2"><p className="text-xs text-muted-foreground">Systemordner</p><p className="text-sm font-medium">{systemOrdnerAnzahl}/{SYSTEM_FOLDER_KEYS.length}</p></div>
            {ersteEbeneTest
              ? <div className="rounded-md border px-3 py-2"><p className="text-xs text-muted-foreground">{ABLAGE_EBENEN_ORDNER[ersteEbene]}</p><p className="text-sm font-medium">{ersteEbeneAnzahl}</p></div>
              : <div className="rounded-md border px-3 py-2"><p className="text-xs text-muted-foreground">Lebensbereiche</p><p className="text-sm font-medium">{lebensbereichOrdnerAnzahl}/{aktiveLebensbereiche.length}</p></div>}
          </CardContent>
        </Card>
      )}

      <SetupWizardCard onDone={onRefresh} backend={backend} />

      {wurzelEingerichtet && <AblageStrukturCard backendLabel={nextcloudAktiv ? 'deinem WebDAV-Speicher' : 'OneDrive'} onDone={onRefresh} />}

      <FehlendeDateienScanCard />

      <DisasterRecoveryCard />
    </div>
  );
}

// ── KI Tab ────────────────────────────────────────────────────────────────────

function KITab() {
  const qc = useQueryClient();

  // EINE Query für Provider-Status UND Modell-Listen: health.providers[id].models
  // trägt seit 1.8.0 [{id,name}]. Vorher lief pro Provider eine eigene
  // useQuery – bei N frei konfigurierbaren Providern wären das N Requests bei
  // jedem Öffnen des Tabs, obwohl der Server die Listen ohnehin schon
  // gesammelt und 60 s gecacht hat.
  const { data: health, isLoading: healthLoading, refetch: refetchHealth } = useQuery({
    queryKey: ['ai-health'],
    queryFn: () => api.settings.ai.health(),
    staleTime: 2 * 60 * 1000,
    retry: false,
  });

  const { data: settings, isLoading: settingsLoading } = useQuery({ queryKey: ['settings'], queryFn: () => api.settings.getAll(), retry: false });
  const { data: providerData } = useQuery({
    queryKey: ['ai-providers'], queryFn: () => api.settings.ai.providers.list(), retry: false,
  });

  // Provider-Stammdaten (Label, caps, aktiv) + die Modell-Liste aus health.
  const providers = (providerData?.providers || []).map((p) => ({
    ...p,
    models: health?.providers?.[p.id]?.models || [],
    embeddingModels: health?.providers?.[p.id]?.embeddingModels || [],
  }));

  const [modelValues, setModelValues] = useState({});  // classKey → { providerId, model }
  const [costValues,  setCostValues]  = useState({});  // model-id → { input_usd_per_1m, output_usd_per_1m, cache_write_usd_per_1m, cache_read_usd_per_1m }
  const [modelSaved, setModelSaved]   = useState(false);

  function getCostVal(modelId) {
    if (!modelId) return undefined;
    if (costValues[modelId] !== undefined) return costValues[modelId];
    const exakt = settings?.[`llm_cost_${modelId}`]?.value;
    if (exakt !== undefined) return exakt;
    // Alias ↔ Snapshot wie calculateCost() im Backend: "claude-haiku-4-5"
    // findet den Preis unter "…-20251001" und umgekehrt. Kein bloßer Präfix –
    // "claude-opus-5-5" hat einen eigenen Preis, nicht den von "claude-opus-5".
    const key = Object.keys(settings || {}).find((k) =>
      k.startsWith('llm_cost_') && gleichesModell(k.slice('llm_cost_'.length), modelId));
    return key ? settings[key]?.value : undefined;
  }

  function effektivesModell(cls) {
    return modelValues[cls.key]?.model ?? health?.models?.[cls.key]?.model ?? null;
  }

  // Dieselbe Modell-ID bei mehreren Klassen mit UNTERSCHIEDLICHEN Providern?
  // Dann teilen sich die Klassen zwangsläufig einen Preis (llm_cost_<modelId>
  // ist providerunabhängig) – das muss im UI stehen, statt etwas anderes zu
  // behaupten als gespeichert wird.
  const providerJeModell = {};
  for (const cls of MODEL_CLASSES) {
    const m = effektivesModell(cls);
    const pid = modelValues[cls.key]?.providerId ?? health?.models?.[cls.key]?.providerId;
    if (!m || !pid) continue;
    (providerJeModell[m] ??= new Set()).add(pid);
  }
  const kostenGeteilt = (modelId) => (providerJeModell[modelId]?.size ?? 0) > 1;

  function handleModelChange(classKey, val) {
    setModelValues((prev) => ({ ...prev, [classKey]: val }));
  }
  function handleCostChange(modelId, val) {
    setCostValues((prev) => ({ ...prev, [modelId]: val }));
  }

  const saveModelsMutation = useMutation({
    mutationFn: async () => {
      for (const cls of MODEL_CLASSES) {
        const v = modelValues[cls.key];
        // Immer als {providerId, model} speichern. Es gibt keinen Pfad mehr,
        // der einen nackten String schreibt – Alt-Strings in der DB bleiben
        // über resolveModelConfig lesbar und werden hier beim ersten
        // Speichern automatisch zu Objekten.
        if (v !== undefined) await api.settings.update(cls.settingKey, v);
      }
      for (const [modelId, costVal] of Object.entries(costValues)) {
        const zahl = (v) => (v != null && v !== '' ? Number(v) : null);
        const inputUsd  = zahl(costVal.input_usd_per_1m);
        const outputUsd = zahl(costVal.output_usd_per_1m);
        // `quelle` mitschreiben: ein hier geänderter Preis ist manuell und darf
        // von der Empfehlungs-Übernahme nicht überschrieben werden. Die
        // Cache-Felder werden immer (auch als null) geschrieben: ein bewusst
        // geleertes Feld darf beim nächsten App-Start nicht wieder mit dem
        // Standard aus base_schema.sql vorbelegt werden.
        const toStore = (inputUsd == null && outputUsd == null)
          ? null
          : {
              input_usd_per_1m: inputUsd,
              output_usd_per_1m: outputUsd,
              cache_write_usd_per_1m: zahl(costVal.cache_write_usd_per_1m),
              cache_read_usd_per_1m: zahl(costVal.cache_read_usd_per_1m),
              quelle: costVal.quelle || 'manuell',
            };
        await api.settings.update(`llm_cost_${modelId}`, toStore);
      }
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['cloudfrei-check'] });
      refetchHealth();
      setModelValues({});
      setCostValues({});
      setModelSaved(true);
      setTimeout(() => setModelSaved(false), 3000);
    },
  });

  const hasChanges = Object.keys(modelValues).length > 0 || Object.keys(costValues).length > 0;

  function renderSelector(cls) {
    return (
      <ModelSelector
        key={cls.key}
        cls={cls}
        wert={modelValues[cls.key]}
        aufgeloest={health?.models?.[cls.key]}
        providers={providers}
        costValue={getCostVal(effektivesModell(cls))}
        kostenGeteilt={kostenGeteilt(effektivesModell(cls))}
        laedt={healthLoading}
        onChange={handleModelChange}
        onCostChange={handleCostChange}
      />
    );
  }

  return (
    <div className="space-y-6">
      <ProviderCard
        health={health}
        onChanged={() => {
          refetchHealth();
          qc.invalidateQueries({ queryKey: ['ai-embedding'] });
          qc.invalidateQueries({ queryKey: ['cloudfrei-check'] });
        }}
      />

      {/* Claude-Subscription bleibt bewusst eine eigene Karte: sie hat einen
          eigenen Freischalt- und Token-Fluss, der sich nicht sinnvoll in die
          generische Provider-Zeile pressen lässt. */}
      {health?.subscription?.unlocked && (
        <ClaudeSubscriptionCard health={health} settings={settings} settingsLoading={settingsLoading} refetchHealth={refetchHealth} />
      )}

      {/* Empfehlungen VOR der Modell-Konfiguration: wer die Klassen einstellt,
          soll die Empfehlung sehen, bevor er von Hand wählt – nicht danach. */}
      <EmpfehlungenCard />

      {/* Model configuration */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Bot className="h-5 w-5 text-primary" />
            <CardTitle className="text-base">Modell-Konfiguration</CardTitle>
            {healthLoading && <Spinner className="h-3.5 w-3.5 ml-auto" />}
            {!healthLoading && <Button variant="ghost" size="icon" className="h-7 w-7 ml-auto" onClick={() => refetchHealth()} title="Status neu prüfen"><RefreshCw className="h-3.5 w-3.5" /></Button>}
          </div>
          <CardDescription className="text-xs pt-1">
            Primärmodell pro Dokumentklasse. Bei Fehlern greift eine Fallback-Kette.
          </CardDescription>
        </CardHeader>
        <CardContent className="pt-0">
          {settingsLoading ? <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Spinner className="h-4 w-4" />Lade…</div> : (
            <>
              {MODEL_CLASSES.filter((c) => !c.group).map(renderSelector)}
              <div className="mt-5 mb-2 pt-4 border-t border-border">
                <p className="text-sm font-semibold">Büroassistent und Akten</p>
                <p className="text-xs text-muted-foreground">Eigene Modellwahl, unabhängig von den Dokumentklassen. Der Büroassistent braucht ein Modell, das Tool-Calling beherrscht.</p>
              </div>
              {MODEL_CLASSES.filter((c) => c.group === 'chat').map(renderSelector)}
            </>
          )}
          {saveModelsMutation.isError && <p className="mt-3 text-sm text-destructive">{saveModelsMutation.error?.message}</p>}
          <div className="mt-4 flex items-center gap-3">
            <Button size="sm" onClick={() => saveModelsMutation.mutate()} disabled={saveModelsMutation.isPending || !hasChanges}>
              {saveModelsMutation.isPending ? 'Speichern…' : 'Modelle speichern'}
            </Button>
            {modelSaved && <span className="text-xs text-emerald-600 flex items-center gap-1"><CheckCircle className="h-3.5 w-3.5" />Gespeichert</span>}
          </div>
        </CardContent>
      </Card>

      <EmbeddingCard providers={providers} />

      {/* Cache-Mode */}
      <CacheModeOptionCard settings={settings} settingsLoading={settingsLoading} />
      {/* Duplikat-Erkennung */}
      <DuplicateDetectionCard settings={settings} settingsLoading={settingsLoading} />
      {/* Eigene Klassifikations-Hinweise */}
      <ClassificationRulesCard settings={settings} settingsLoading={settingsLoading} />

      {/* Kostenträger-Profile für den Erstattungsbescheid-Parser */}
      <KostentraegerProfilCard />

      {/* System-Prompts (nur informatorisch) */}
      <SystemPromptsCard />
    </div>
  );
}

// Freitext-Hinweise, die der Admin dem KI-Klassifikations-Prompt mitgibt
// (z. B. Kontextwissen "Fabi ist unser Pferd" oder Inferenzregeln "PAID-Stempel = bezahlt").
// Persistiert als _settings-Key classification_custom_rules; greift bei jeder Analyse.
const CLASSIFICATION_RULES_MAX = 6000;
function ClassificationRulesCard({ settings, settingsLoading }) {
  const qc = useQueryClient();

  const stored = settings?.classification_custom_rules?.value ?? '';
  const [draft, setDraft] = useState(null);   // null = unverändert (zeigt stored)
  const [saved, setSaved] = useState(false);

  const value = draft !== null ? draft : String(stored);

  const saveMutation = useMutation({
    mutationFn: async () => {
      await api.settings.update('classification_custom_rules', value.slice(0, CLASSIFICATION_RULES_MAX));
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      setDraft(null);
      setSaved(true);
      globalThis.setTimeout(() => setSaved(false), 3000);
    },
  });

  const hasChanges = draft !== null && draft !== String(stored);

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <MessageSquare className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">Eigene Klassifikations-Hinweise</CardTitle>
        </div>
        <CardDescription className="text-xs pt-1">
          Ergänzt den KI-Systemprompt bei jeder Analyse. Schreibe so, als würdest du einer sachkundigen Person kurze Hintergrundinformationen geben.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        {settingsLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Spinner className="h-4 w-4" />Lade…</div>
        ) : (
          <>
            <textarea
              value={value}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={CLASSIFICATION_RULES_MAX}
              placeholder={`Fabi ist unser Pferd (Ausgaben dafür → Kategorie Tier)
Rechnungen mit PAID-Stempel oder Wasserzeichen sind bereits bezahlt
Unser Vermieter heißt Müller Immobilien GmbH
Tankbelege von der Aral Hauptstraße gehören zu Auto, nicht zu Freizeit`}
              className="w-full min-h-[120px] resize-y rounded-md border border-input bg-background px-2 py-1.5 text-sm font-mono"
            />
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground tabular-nums">{value.length} / {CLASSIFICATION_RULES_MAX}</span>
            </div>
            {saveMutation.isError && <p className="text-sm text-destructive">{saveMutation.error?.message}</p>}
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !hasChanges}>
                {saveMutation.isPending ? 'Speichern…' : 'Speichern'}
              </Button>
              {saved && <span className="text-xs text-emerald-600 flex items-center gap-1"><CheckCircle className="h-3.5 w-3.5" />Gespeichert</span>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// System-Prompts-Vorschau: zeigt dem Admin alle an das LLM gesendeten
// System-Prompts vollständig und mit zur Laufzeit aufgelösten Variablen
// (Personenlisten, eigene Klassifikations-Hinweise). Rein informatorisch –
// keine Änderungsmöglichkeit. Daten werden erst beim Öffnen geladen.
function SystemPromptsCard() {
  const [open, setOpen] = useState(false);
  const [expanded, setExpanded] = useState(null);   // id des aufgeklappten Prompts
  const [copiedId, setCopiedId] = useState(null);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['settings', 'prompts-preview'],
    queryFn: () => api.settings.promptsPreview(),
    enabled: open,
    staleTime: 60_000,
  });

  const prompts = data?.prompts ?? [];

  const copy = async (p) => {
    const text = p.userMessage
      ? `${p.system}\n\n--- User-Nachricht ---\n${p.userMessage}`
      : p.system;
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(p.id);
      globalThis.setTimeout(() => setCopiedId(null), 2000);
    } catch { /* Clipboard nicht verfügbar */ }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <FileText className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">System-Prompts</CardTitle>
          <Badge variant="outline" className="text-[10px]">nur Anzeige</Badge>
        </div>
        <CardDescription className="text-xs pt-1">
          Zeigt alle an die KI gesendeten System-Prompts vollständig an – mit aufgelösten Variablen
          (Personen-/Patientenlisten, eigene Hinweise), genau so, wie sie das Modell erhält.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
          <Eye className="h-4 w-4 mr-1.5" />System-Prompts anzeigen
        </Button>
      </CardContent>

      {open && createPortal(
        <div className="fixed inset-0 z-[1000] isolate flex items-center justify-center p-4">
          <div className="fixed inset-0 bg-foreground/30 backdrop-blur-sm" onClick={() => setOpen(false)} />
          <div role="dialog" aria-modal="true" className="relative z-10 flex w-full max-w-4xl max-h-[88vh] flex-col rounded-xl bg-background shadow-2xl border border-border/60 animate-in fade-in">
            <div className="flex items-center justify-between gap-3 border-b border-border/60 px-5 py-3.5">
              <div className="flex items-center gap-2 min-w-0">
                <FileText className="h-5 w-5 text-primary flex-shrink-0" />
                <h2 className="text-base font-semibold truncate">System-Prompts (aufgelöst)</h2>
              </div>
              <button onClick={() => setOpen(false)} className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground" aria-label="Schließen">
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4 space-y-3">
              {isLoading && (
                <div className="flex items-center gap-2 py-8 justify-center text-sm text-muted-foreground"><Spinner className="h-4 w-4" />Lade Prompts…</div>
              )}
              {isError && (
                <p className="text-sm text-destructive py-4">{error?.message || 'Fehler beim Laden der Prompts.'}</p>
              )}
              {!isLoading && !isError && prompts.map((p) => {
                const isOpen = expanded === p.id;
                return (
                  <div key={p.id} className="rounded-lg border border-border/60 overflow-hidden">
                    <button
                      onClick={() => setExpanded(isOpen ? null : p.id)}
                      className="flex w-full items-center gap-2 px-3.5 py-3 text-left hover:bg-muted/50"
                    >
                      {isOpen ? <ChevronDown className="h-4 w-4 flex-shrink-0 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 flex-shrink-0 text-muted-foreground" />}
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-medium truncate">{p.title}</span>
                          {p.dynamic && <Badge variant="secondary" className="text-[10px]">Beispieldaten</Badge>}
                        </div>
                        <p className="text-xs text-muted-foreground mt-0.5 line-clamp-2">{p.description}</p>
                      </div>
                    </button>
                    {isOpen && (
                      <div className="border-t border-border/60 bg-muted/30">
                        <div className="flex items-center justify-end px-3 pt-2.5">
                          <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => copy(p)}>
                            {copiedId === p.id
                              ? <><Check className="h-3.5 w-3.5 mr-1 text-emerald-600" />Kopiert</>
                              : <><Copy className="h-3.5 w-3.5 mr-1" />Kopieren</>}
                          </Button>
                        </div>
                        <pre className="overflow-x-auto px-3.5 pb-3.5 text-[11px] leading-relaxed whitespace-pre-wrap break-words font-mono text-foreground/90">{p.system}</pre>
                        {p.userMessage && (
                          <div className="border-t border-border/60 px-3.5 py-3">
                            <p className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">Begleitende User-Nachricht</p>
                            <pre className="overflow-x-auto text-[11px] leading-relaxed whitespace-pre-wrap break-words font-mono text-foreground/90">{p.userMessage}</pre>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="border-t border-border/60 px-5 py-3 text-right">
              <Button size="sm" variant="outline" onClick={() => setOpen(false)}>Schließen</Button>
            </div>
          </div>
        </div>,
        document.body,
      )}
    </Card>
  );
}

// Claude-Subscription: claude-* Modelle über das Agent SDK (Pauschaltarif) statt
// über den Anthropic-API-Key abrechnen. Nur sichtbar, wenn das dev-Key-Feature
// (ENV POSTBUCH_SDK_DEV_KEY) freigeschaltet ist → health.subscription.unlocked.
function ClaudeSubscriptionCard({ health, settings, settingsLoading, refetchHealth }) {
  const qc = useQueryClient();
  const sub = health?.subscription;
  const enabled    = settings?.llm_claude_subscription_enabled?.value === true;
  const configured = !!sub?.configured;

  const [token, setToken]   = useState('');
  const [show, setShow]     = useState(false);
  const [saved, setSaved]   = useState(false);
  const [testResult, setTestResult] = useState(null);

  const toggleMutation = useMutation({
    mutationFn: (next) => api.settings.update('llm_claude_subscription_enabled', next),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['settings'] }); refetchHealth(); },
  });
  const saveTokenMutation = useMutation({
    mutationFn: (t) => api.settings.ai.setKey('subscription', t),
    onSuccess: () => { setToken(''); setSaved(true); setTestResult(null); refetchHealth(); setTimeout(() => setSaved(false), 4000); },
  });
  const testMutation = useMutation({
    mutationFn: () => api.settings.ai.subscriptionTest(),
    onSuccess: (r) => setTestResult(r),
    onError: (e) => setTestResult({ ok: false, error: e.message }),
  });

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Coins className="h-5 w-5 text-violet-500" />
          <CardTitle className="text-base">Claude-Subscription</CardTitle>
          <Badge variant="secondary" className="text-[10px]">Beta</Badge>
          {configured
            ? <Badge variant="default" className="ml-auto text-[10px] bg-emerald-500">Token hinterlegt</Badge>
            : <Badge variant="outline" className="ml-auto text-[10px] text-amber-500 border-amber-500/40">Kein Token</Badge>}
        </div>
        <CardDescription className="text-xs pt-1">
          Rechnet alle Claude-Modelle (claude-*) über eine Claude Pro/Max/Team-Subscription statt über den
          Anthropic-API-Key ab – pauschal statt pro Token. OpenAI-Fallback und Bedrock bleiben unberührt.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0 space-y-4">
        {settingsLoading ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground"><Spinner className="h-4 w-4" />Lade…</div>
        ) : (
          <>
            {/* Globaler Schalter */}
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">Claude-Modelle über Subscription abrechnen</p>
                <p className="text-xs text-muted-foreground">
                  Aktiv nur mit hinterlegtem Token. Ohne Token oder bei Fehlern greift automatisch die normale Fallback-Kette.
                </p>
              </div>
              <ToggleSwitch
                checked={enabled}
                disabled={toggleMutation.isPending || !configured}
                onChange={() => toggleMutation.mutate(!enabled)}
              />
            </div>

            {/* Token-Eingabe */}
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                {configured ? 'Neuen Token eingeben (leer lassen = unverändert)' : 'OAuth-Token einfügen'}
              </label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Input
                    type={show ? 'text' : 'password'}
                    value={token}
                    onChange={(e) => setToken(e.target.value)}
                    placeholder={configured ? '••••••••••••••••' : 'sk-ant-oat… / Token aus „claude setup-token"'}
                    className="h-9 text-sm font-mono pr-9"
                    autoComplete="new-password"
                  />
                  <button type="button" onClick={() => setShow(!show)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground">
                    {show ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
                  </button>
                </div>
                <Button size="sm" onClick={() => saveTokenMutation.mutate(token)} disabled={saveTokenMutation.isPending || !token.trim()} className="h-9">
                  {saveTokenMutation.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Save className="h-3.5 w-3.5" />}
                </Button>
              </div>
            </div>

            <p className="text-xs text-muted-foreground">
              Token lokal erzeugen mit <code className="font-mono text-[11px] bg-muted px-1 py-0.5 rounded">claude setup-token</code>{' '}
              (Browser-Login, Pro/Max/Team nötig) und hier einfügen. Gültigkeit ca. 1 Jahr – danach neu erzeugen.
            </p>

            {/* Test */}
            <div className="flex items-center gap-3">
              <Button variant="outline" size="sm" onClick={() => { setTestResult(null); testMutation.mutate(); }} disabled={testMutation.isPending || !configured}>
                {testMutation.isPending ? <><Spinner className="h-3.5 w-3.5 mr-1.5" />Teste…</> : 'Verbindung testen'}
              </Button>
              {testResult && (testResult.ok
                ? <span className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1"><ShieldCheck className="h-3.5 w-3.5" />Subscription erreichbar</span>
                : <span className="text-xs text-destructive flex items-center gap-1"><ShieldX className="h-3.5 w-3.5" />{testResult.error || 'Fehler'}</span>)}
            </div>

            {saved && <p className="text-xs text-emerald-600 dark:text-emerald-400 flex items-center gap-1"><CheckCircle className="h-3.5 w-3.5" />Token gespeichert</p>}
            {(toggleMutation.isError || saveTokenMutation.isError) && (
              <p className="text-xs text-destructive">{(toggleMutation.error || saveTokenMutation.error)?.message}</p>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

const CACHE_TIER_LABEL = { leicht: 'Leicht', mittel: 'Mittel', schwierig: 'Schwer' };

function resolveTierModelName(settings, tier) {
  const val = settings?.[`llm_model_${tier}`]?.value;
  if (!val) return null;
  return typeof val === 'object' ? (val.model || null) : String(val);
}

function CacheModeOptionCard({ settings, settingsLoading }) {
  const qc = useQueryClient();
  const enabled  = settings?.llm_cache_mode_enabled?.value === true;
  const auto     = settings?.llm_cache_mode_auto?.value === true;
  const autoTier = CACHE_TIER_LABEL[settings?.llm_cache_mode_auto_tier?.value] ? settings.llm_cache_mode_auto_tier.value : 'mittel';

  const mutation = useMutation({
    mutationFn: (next) => api.settings.update('llm_cache_mode_enabled', next),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });
  const autoMutation = useMutation({
    mutationFn: (next) => api.settings.update('llm_cache_mode_auto', next),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });
  const tierMutation = useMutation({
    mutationFn: (next) => api.settings.update('llm_cache_mode_auto_tier', next),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['settings'] }),
  });

  const busy = mutation.isPending || autoMutation.isPending || tierMutation.isPending;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <Coins className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">Cache-Mode</CardTitle>
        </div>
        <CardDescription className="text-xs pt-1">
          Batch-Modus mit providerabhängigem Prompt-Caching und fixem Klassifikationsmodell. Reduziert die
          Token-Kosten bei der Verarbeitung mehrerer Dokumente.
        </CardDescription>
      </CardHeader>
      <CardContent className="pt-0">
        {settingsLoading ? (
          <div className="flex items-center gap-2 py-2 text-sm text-muted-foreground"><Spinner className="h-4 w-4" />Lade…</div>
        ) : (
          <div className="divide-y divide-border">
            <div className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">Cache-Mode auf der Import-Seite anbieten</p>
                <p className="text-xs text-muted-foreground">Manueller Start/Stopp-Schalter im Import. Wenn deaktiviert, ist der Schalter dort nicht sichtbar.</p>
              </div>
              <ToggleSwitch checked={enabled} disabled={busy} onChange={() => mutation.mutate(!enabled)} />
            </div>

            <div className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="text-sm font-medium">Automatisch aktivieren</p>
                <p className="text-xs text-muted-foreground">
                  Springt an, sobald ein Schwung (mehrere Dateien gleichzeitig) eingeht oder innerhalb von 5 Minuten
                  ein zweites Dokument eintrifft. Reset nach 15 Min ohne neue Verarbeitung. Funktioniert unabhängig
                  vom Schalter oben.
                </p>
              </div>
              <ToggleSwitch checked={auto} disabled={busy} onChange={() => autoMutation.mutate(!auto)} />
            </div>

            {auto && (
              <div className="flex items-center justify-between gap-4 py-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Modellvorgabe für Auto-Modus</p>
                  <p className="text-xs text-muted-foreground">Festes Klassifikationsmodell, auf das die Auto-Aktivierung bündelt.</p>
                </div>
                <select
                  value={autoTier}
                  onChange={(e) => tierMutation.mutate(e.target.value)}
                  disabled={busy}
                  className="h-9 text-sm rounded-md border border-input bg-background px-2 cursor-pointer disabled:opacity-60"
                >
                  {['leicht', 'mittel', 'schwierig'].map((t) => {
                    const m = resolveTierModelName(settings, t);
                    return <option key={t} value={t}>{CACHE_TIER_LABEL[t]}{m ? ` (${m})` : ''}</option>;
                  })}
                </select>
              </div>
            )}
          </div>
        )}
        {(mutation.isError || autoMutation.isError || tierMutation.isError) && (
          <p className="mt-2 text-sm text-destructive">{(mutation.error || autoMutation.error || tierMutation.error)?.message}</p>
        )}
      </CardContent>
    </Card>
  );
}

function DuplicateDetectionCard({ settings, settingsLoading }) {
  const qc = useQueryClient();

  const thresholdRaw = settings?.duplicate_embedding_threshold?.value ?? 0.90;
  const timeoutRaw   = settings?.duplicate_decision_timeout_min?.value ?? 60;

  const [threshold, setThreshold] = useState(null);
  const [timeout, setTimeout]     = useState(null);
  const [saved, setSaved]         = useState(false);

  const displayThreshold = threshold !== null ? threshold : Number(thresholdRaw);
  const displayTimeout   = timeout   !== null ? timeout   : Number(timeoutRaw);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (threshold !== null) await api.settings.update('duplicate_embedding_threshold', threshold);
      if (timeout   !== null) await api.settings.update('duplicate_decision_timeout_min', timeout);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      setThreshold(null);
      setTimeout(null);
      setSaved(true);
      globalThis.setTimeout(() => setSaved(false), 3000);
    },
  });

  const hasChanges = threshold !== null || timeout !== null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" />
          <CardTitle className="text-base">Duplikat-Erkennung</CardTitle>
        </div>
        <CardDescription className="text-xs pt-1">
          Cosinus-Ähnlichkeits-Schwelle und Entscheidungs-Timeout für die embedding-basierte Duplikaterkennung. Bei bewusst eingerichteter experimenteller Discord-Anbindung gilt: Bot-Konfiguration → native Buttons, sonst Magic-Link.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 pt-0">
        {settingsLoading ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Spinner className="h-4 w-4" />Lade…</div>
        ) : (
          <>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">
                Cosinus-Schwelle: <span className="font-mono font-medium text-foreground">{(displayThreshold * 100).toFixed(0)}%</span>
              </label>
              <input
                type="range"
                min={0.70}
                max={0.99}
                step={0.01}
                value={displayThreshold}
                onChange={(e) => setThreshold(Number(e.target.value))}
                className="w-full"
              />
              <p className="text-xs text-muted-foreground">
                Dokumente mit Ähnlichkeit ≥ {(displayThreshold * 100).toFixed(0)}% werden als Duplikat-Kandidaten gewertet.
              </p>
            </div>
            <div className="space-y-1.5">
              <label className="text-xs text-muted-foreground">
                Entscheidungs-Timeout (Minuten)
              </label>
              <input
                type="number"
                min={5}
                max={1440}
                value={displayTimeout}
                onChange={(e) => setTimeout(Number(e.target.value))}
                className="h-8 w-28 rounded-md border border-input bg-background px-2 text-sm"
              />
              <p className="text-xs text-muted-foreground">
                Nach {displayTimeout} Minuten ohne Entscheidung: Auto-Replace wenn bessere Qualität, sonst Auto-Discard.
              </p>
            </div>
            <div className="flex items-center gap-3">
              <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending || !hasChanges}>
                {saveMutation.isPending ? 'Speichern…' : 'Speichern'}
              </Button>
              {saved && <span className="text-xs text-emerald-600 flex items-center gap-1"><CheckCircle className="h-3.5 w-3.5" />Gespeichert</span>}
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Allgemein Tab ─────────────────────────────────────────────────────────────

function AllgemeinTab() {
  const qc = useQueryClient();
  const { data: settings, isLoading, isError, error: ladeFehler, refetch, isFetching } = useQuery({ queryKey: ['settings'], queryFn: () => api.settings.getAll(), retry: false });

  const [form, setForm]   = useState(null);
  const [saved, setSaved] = useState(false);
  const [dbStatus, setDbStatus] = useState(null);
  const [dbTesting, setDbTesting] = useState(false);

  useEffect(() => {
    if (settings && form === null) {
      const vis = settings.nav_visibility?.value || {};
      setForm({
        instance_name:  settings.instance_name?.value ?? '',
        app_host:       settings.app_host?.value ?? '',
        show_salden:    vis.salden  !== false,
        show_logs:      vis.logs    !== false,
        pipeline_max_parallel: Number(settings.pipeline_max_parallel?.value ?? 3),
        salden_quellen_aktiv: settings.salden_quellen_aktiv?.value === true,
      });
    }
  }, [settings, form]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      await api.settings.update('instance_name', form.instance_name.trim());
      await api.settings.update('app_host', form.app_host.trim());
      await api.settings.update('nav_visibility', { salden: form.show_salden, logs: form.show_logs });
      const n = Math.max(1, Math.min(10, Math.trunc(Number(form.pipeline_max_parallel)) || 3));
      await api.settings.update('pipeline_max_parallel', n);
      await api.settings.update('salden_quellen_aktiv', form.salden_quellen_aktiv);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
  });

  async function testDb() {
    setDbTesting(true);
    setDbStatus(null);
    try {
      const res = await fetch('/api/health', { credentials: 'include' });
      if (res.ok) setDbStatus({ ok: true, msg: 'Datenbankverbindung ist aktiv.' });
      else setDbStatus({ ok: false, msg: `HTTP ${res.status}` });
    } catch (e) {
      setDbStatus({ ok: false, msg: e.message });
    } finally {
      setDbTesting(false);
    }
  }

  if (isError && !form) return <EinstellungenLadefehler fehler={ladeFehler} onRetry={refetch} laedt={isFetching} />;
  if (isLoading || !form) return <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Spinner className="h-4 w-4" />Lade…</div>;

  return (
    <div className="space-y-6">
      {/* Ganz oben, aber eingeklappt: der eine Bildschirm, den die cloudfreie
          Zielgruppe sehen will – ohne allen anderen Platz wegzunehmen. */}
      <CloudfreiCard />

      {/* Versionsstand + Update. Direkt unter dem Cloudfrei-Check: beides sind
          Aussagen über die Instanz als Ganzes, nicht über eine Funktion. */}
      <UpdateCard />

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2"><Globe className="h-5 w-5 text-primary" /><CardTitle className="text-base">Instanz</CardTitle></div>
          <CardDescription className="text-xs pt-1">Allgemeine Informationen und Bezeichnung dieser postbuch.net-Instanz.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Instanzname</label>
            <Input value={form.instance_name} onChange={(e) => setForm({ ...form, instance_name: e.target.value })} placeholder="z. B. Familie Doe" className="h-9 text-sm" />
            <p className="text-xs text-muted-foreground">Wird in der Seitenleiste und im Seitentitel angezeigt.</p>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">App-URL (Basis-URL)</label>
            <Input value={form.app_host} onChange={(e) => setForm({ ...form, app_host: e.target.value })} placeholder="https://postbuch.example.com" className="h-9 text-sm font-mono" />
            <p className="text-xs text-muted-foreground">Wird für Links in Benachrichtigungen und beim OneDrive-Browser-Redirect für die Callback-URL verwendet. Ohne Abschluss-Slash. Ohne Eintrag werden keine Magic-Links generiert und der Browser-Redirect kann nicht gestartet werden.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Sichtbarkeit für normale Nutzer</CardTitle>
          <CardDescription className="text-xs pt-1">
            Admins sehen immer alle Menüpunkte. Hier kannst du einzelne Punkte für Nutzer ohne Admin-Rechte ausblenden.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {[
            { key: 'show_salden', label: 'Salden', desc: 'Konten und Buchungen (Analyse → Salden)' },
            { key: 'show_logs',   label: 'Logs',   desc: 'Systemprotokolle' },
          ].map(({ key, label, desc }) => (
            <div key={key} className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm font-medium">{label}</p>
                <p className="text-xs text-muted-foreground">{desc}</p>
              </div>
              <button type="button" onClick={() => setForm({ ...form, [key]: !form[key] })} className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${form[key] ? 'bg-primary' : 'bg-muted'}`}>
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${form[key] ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>
          ))}

          <div className="border-t pt-3">
            <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2.5 mb-3">
              <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-700 dark:text-amber-400">
                Salden-Quellen (frei formuliertes SQL, das ein Saldo aus Dokumentdaten speist) sind ein
                Experten-Feature, das Datenbank- und SQL-Kenntnisse voraussetzt und bewusst nicht in der
                Nutzerdoku beschrieben ist. Ein fehlerhaftes Statement führt zu falschen Salden.
              </p>
            </div>
            <div className="flex items-center justify-between py-1">
              <div>
                <div className="flex items-center gap-2">
                  <p className="text-sm font-medium">SQL-Quellen aktivieren</p>
                  <Badge variant="outline" className="border-amber-400 text-amber-700">Nur für Entwickler</Badge>
                </div>
                <p className="text-xs text-muted-foreground">Erlaubt Admins, in Salden → Quelle hinzufügen SQL-Quellen anzulegen oder zu bearbeiten.</p>
              </div>
              <button type="button" onClick={() => setForm({ ...form, salden_quellen_aktiv: !form.salden_quellen_aktiv })}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors flex-shrink-0 ${form.salden_quellen_aktiv ? 'bg-primary' : 'bg-muted'}`}>
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${form.salden_quellen_aktiv ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2"><Cpu className="h-5 w-5 text-primary" /><CardTitle className="text-base">Verarbeitungs-Pipeline</CardTitle></div>
          <CardDescription className="text-xs pt-1">Wie viele Dokumente dürfen gleichzeitig durch die KI-Pipeline laufen? Weitere Dokumente werden in einer Warteschlange gepuffert.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Max. parallel (1–10)</label>
            <Input
              type="number"
              min="1"
              max="10"
              step="1"
              value={form.pipeline_max_parallel}
              onChange={(e) => setForm({ ...form, pipeline_max_parallel: e.target.value })}
              className="h-9 text-sm w-24"
            />
            <p className="text-xs text-muted-foreground">Standard: 3. Höhere Werte beschleunigen Bursts, belasten aber RAM/CPU/OneDrive- und KI-API stärker.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2"><Database className="h-5 w-5 text-primary" /><CardTitle className="text-base">Datenbankverbindung</CardTitle></div>
          <CardDescription className="text-xs pt-1">PostgreSQL-Verbindung testen. Verbindungsparameter werden über Umgebungsvariablen konfiguriert.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <Button size="sm" variant="outline" onClick={testDb} disabled={dbTesting}>
            {dbTesting ? <><Spinner className="h-3.5 w-3.5 mr-1.5" />Prüfe…</> : <><Database className="h-3.5 w-3.5 mr-1.5" />Verbindung testen</>}
          </Button>
          {dbStatus && (
            <div className={`flex items-center gap-2 text-sm ${dbStatus.ok ? 'text-emerald-600 dark:text-emerald-400' : 'text-destructive'}`}>
              {dbStatus.ok ? <CheckCircle className="h-4 w-4 flex-shrink-0" /> : <AlertCircle className="h-4 w-4 flex-shrink-0" />}
              {dbStatus.msg}
            </div>
          )}
        </CardContent>
      </Card>

      {saveMutation.isError && <p className="text-sm text-destructive">{saveMutation.error?.message}</p>}
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? 'Speichern…' : 'Einstellungen speichern'}
        </Button>
        {saved && <span className="text-xs text-emerald-600 flex items-center gap-1"><CheckCircle className="h-3.5 w-3.5" />Gespeichert</span>}
      </div>
    </div>
  );
}

// ── Scanner Tab ───────────────────────────────────────────────────────────────

const SCAN_QUELLEN_LABELS = { flatbed: 'Flachbett', adf: 'ADF', 'adf-duplex': 'ADF duplex' };
const SCAN_MODUS_LABELS   = { gray: 'Graustufen', color: 'Farbe', bw: 'Schwarzweiß' };

function ScannerTab() {
  const qc = useQueryClient();
  const { data: settings, isLoading, isError, error: ladeFehler, refetch, isFetching } = useQuery({ queryKey: ['settings'], queryFn: () => api.settings.getAll(), retry: false });

  const [form, setForm]   = useState(null);
  const [saved, setSaved] = useState(false);

  // Fähigkeitsermittlung. Freiwillig – ohne sie gilt der bisherige Stand.
  // Das Gerät hat gerade live geantwortet, was es kann – die Ausstattung
  // (ADF/Duplex/A3) wird deshalb direkt übernommen, nicht nur vorgeschlagen.
  // Ein Fehlversuch lässt einen vorhandenen Stand unberührt.
  const [angewendeteAusstattung, setAngewendeteAusstattung] = useState(null);
  const [lokaleCapabilities, setLokaleCapabilities] = useState(null);
  const [capabilitiesPersistiert, setCapabilitiesPersistiert] = useState(true);
  const ermitteln = useMutation({
    mutationFn: () => api.settings.scannerCapabilities(form?.scanner_device_url),
    onSuccess: (res) => {
      setLokaleCapabilities(res.capabilities || null);
      setCapabilitiesPersistiert(res.persistiert !== false);
      if (res.persistiert !== false && res.ausstattung) {
        setForm((prev) => (prev ? { ...prev, ...res.ausstattung } : prev));
        setAngewendeteAusstattung(res.ausstattung);
      }
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['settings-public'] });
      // Ein Scanner, der gerade live geantwortet hat, soll auch benutzt werden
      // können – spiegelt den Assistenten (EinrichtungPage.jsx). Nur wenn der
      // getestete Wert auch der gespeicherte ist, der Host-Agent das Profil
      // steuern kann und es nicht ohnehin schon läuft.
      if (res.persistiert !== false && profilSteuerbar && agent?.scannerProfilAktiv === false && !profilSchalten.isPending) {
        profilSchalten.mutate(true);
      }
    },
  });

  const capabilities = lokaleCapabilities ?? settings?.scanner_capabilities?.value ?? null;

  // Das Scannerprofil selbst gehört dem Host-Agenten, nicht der App. Der
  // Assistent schaltet es bei einem erfolgreichen Test automatisch ein;
  // ausschalten kann man es nur hier – und nur nach ausdrücklicher Rückfrage,
  // weil danach kein Scan mehr ankommt.
  const [profilAusFrage, setProfilAusFrage] = useState(false);
  const updates = useQuery({ queryKey: ['updates'], queryFn: () => api.updates.get(), retry: false });
  const agent = updates.data?.agent;
  const profilSteuerbar = !!agent?.vorhanden && !!agent.capabilities?.includes('module');
  const profilSchalten = useMutation({
    mutationFn: (an) => api.updates.hostconfig('module', an ? 'scanner:an' : 'scanner:aus'),
    onSuccess: () => { setProfilAusFrage(false); updates.refetch(); },
  });

  // Scanner entfernen: URL leeren, gespeicherte Fähigkeiten fallen serverseitig
  // mit weg (routes/settings.js), das Compose-Profil wird dort automatisch
  // abgeschaltet. Rückfrage, weil danach keine Scans mehr ankommen.
  const [scannerEntfernenFrage, setScannerEntfernenFrage] = useState(false);
  const scannerEntfernen = useMutation({
    mutationFn: () => api.settings.update('scanner_device_url', ''),
    onSuccess: () => {
      setForm((prev) => (prev ? { ...prev, scanner_device_url: '' } : prev));
      setLokaleCapabilities(null);
      setCapabilitiesPersistiert(true);
      setAngewendeteAusstattung(null);
      setScannerEntfernenFrage(false);
      qc.invalidateQueries({ queryKey: ['settings'] });
      qc.invalidateQueries({ queryKey: ['settings-public'] });
      updates.refetch();
    },
  });

  useEffect(() => {
    if (settings && form === null) {
      setForm({
        scanner_device_url:             settings.scanner_device_url?.value             ?? '',
        scanner_default_dpi:            settings.scanner_default_dpi?.value            ?? 300,
        scanner_default_mode:           settings.scanner_default_mode?.value           ?? 'gray',
        scanner_has_adf:                settings.scanner_has_adf?.value                ?? false,
        scanner_supports_a3:            settings.scanner_supports_a3?.value            ?? false,
        scanner_adf_duplex:             settings.scanner_adf_duplex?.value             ?? false,
        cleaner_ocr_enabled:            settings.cleaner_ocr_enabled?.value            ?? true,
        cleaner_ocr_langs:              settings.cleaner_ocr_langs?.value              ?? 'deu',
        cleaner_ocr_jobs:               settings.cleaner_ocr_jobs?.value               ?? 1,
        cleaner_blank_mean_min:         settings.cleaner_blank_mean_min?.value         ?? 240,
        cleaner_blank_stddev_max:       settings.cleaner_blank_stddev_max?.value       ?? 12,
        cleaner_blank_mean_min_single:  settings.cleaner_blank_mean_min_single?.value  ?? 253,
        cleaner_blank_stddev_max_single: settings.cleaner_blank_stddev_max_single?.value ?? 4,
        cleaner_blank_content_threshold: settings.cleaner_blank_content_threshold?.value ?? 200,
        cleaner_blank_mask_max_content_px: settings.cleaner_blank_mask_max_content_px?.value ?? 200,
        cleaner_crop_enabled:           settings.cleaner_crop_enabled?.value           ?? true,
        cleaner_detect_dpi:             settings.cleaner_detect_dpi?.value             ?? 75,
        cleaner_content_threshold:      settings.cleaner_content_threshold?.value      ?? 200,
        cleaner_content_denoise_min_px: settings.cleaner_content_denoise_min_px?.value ?? 10,
      });
    }
  }, [settings, form]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      const keys = [
        'scanner_device_url', 'scanner_default_dpi', 'scanner_default_mode',
        'scanner_has_adf', 'scanner_supports_a3', 'scanner_adf_duplex',
        'cleaner_ocr_enabled', 'cleaner_ocr_langs', 'cleaner_ocr_jobs',
        'cleaner_blank_mean_min', 'cleaner_blank_stddev_max',
        'cleaner_blank_mean_min_single', 'cleaner_blank_stddev_max_single',
        'cleaner_blank_content_threshold', 'cleaner_blank_mask_max_content_px',
        'cleaner_crop_enabled', 'cleaner_detect_dpi',
        'cleaner_content_threshold', 'cleaner_content_denoise_min_px',
      ];
      for (const k of keys) await api.settings.update(k, form[k]);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['settings'] });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    },
  });

  function field(key) {
    return {
      value: form[key] ?? '',
      onChange: (e) => setForm({ ...form, [key]: e.target.value }),
    };
  }
  function numField(key) {
    return {
      type: 'number',
      value: form[key] ?? '',
      onChange: (e) => setForm({ ...form, [key]: Number(e.target.value) }),
    };
  }
  function toggle(key) {
    return {
      checked: !!form[key],
      onClick: () => setForm({ ...form, [key]: !form[key] }),
    };
  }

  if (isError && !form) return <EinstellungenLadefehler fehler={ladeFehler} onRetry={refetch} laedt={isFetching} />;
  if (isLoading || !form) return <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Spinner className="h-4 w-4" />Lade…</div>;

  return (
    <div className="space-y-6">

      {/* Scanner-Gerät */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2"><ScanLine className="h-5 w-5 text-primary" /><CardTitle className="text-base">Scanner-Gerät</CardTitle></div>
          <CardDescription className="text-xs pt-1">
            Wird live übernommen – kein Neustart nötig. Scanner pollt diese Werte alle 30 Sekunden.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-1">
            <div className="flex items-center justify-between gap-2">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Geräte-URL (eSCL)</label>
              <ScannerDiscoveryCard onSelect={(treffer) => {
                const ausstattung = {
                  scanner_has_adf: Boolean(treffer.capabilities?.quellen?.adf || treffer.capabilities?.quellen?.['adf-duplex']),
                  scanner_adf_duplex: Boolean(treffer.capabilities?.quellen?.['adf-duplex']),
                  scanner_supports_a3: (treffer.capabilities?.quellen?.flatbed?.maxBreiteMm || 0) >= 297
                    && (treffer.capabilities?.quellen?.flatbed?.maxHoeheMm || 0) >= 420,
                };
                setForm((prev) => ({ ...prev, scanner_device_url: treffer.url, ...ausstattung }));
                setLokaleCapabilities(treffer.capabilities || null);
                setCapabilitiesPersistiert(false);
                setAngewendeteAusstattung(ausstattung);
              }} />
            </div>
            <div className="flex items-center gap-2">
              <Input {...field('scanner_device_url')} placeholder="http://192.168.x.x:80/eSCL" className="h-9 text-sm font-mono" />
              {!!settings?.scanner_device_url?.value && (
                <Button
                  variant="outline"
                  size="sm"
                  className="h-9 shrink-0 text-destructive hover:text-destructive"
                  onClick={() => setScannerEntfernenFrage(true)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
            <p className="text-xs text-muted-foreground">IP-Adresse und Pfad des eSCL-Endpunkts. Bei Scanner-Wechsel nur diese URL anpassen. Leer lassen und speichern entfernt den Scanner nicht sofort – dafür den Papierkorb-Knopf nutzen.</p>
          </div>

          <Dialog open={scannerEntfernenFrage} onOpenChange={(o) => { if (!o && !scannerEntfernen.isPending) setScannerEntfernenFrage(false); }}>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0" />Scanner entfernen?
            </DialogTitle>
            <DialogDescription className="mt-3">
              Geräteadresse und ermittelte Fähigkeiten werden gelöscht. Läuft ein Host-Agent, wird das
              Scanner-Profil dabei automatisch abgeschaltet – danach nimmt postbuch.net keine Scans mehr
              entgegen, bis erneut eine Geräteadresse eingerichtet wird.
            </DialogDescription>
            {scannerEntfernen.isError && <Testergebnis status="fehler">{scannerEntfernen.error.message}</Testergebnis>}
            <DialogFooter>
              <Button variant="outline" onClick={() => setScannerEntfernenFrage(false)} disabled={scannerEntfernen.isPending}>Abbrechen</Button>
              <Button variant="destructive" onClick={() => scannerEntfernen.mutate()} disabled={scannerEntfernen.isPending}>
                {scannerEntfernen.isPending ? 'Wird entfernt…' : 'Scanner entfernen'}
              </Button>
            </DialogFooter>
          </Dialog>

          {profilSteuerbar && (
            <div className="rounded-lg border border-border/60 bg-muted/30 p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-medium">Scannerprofil</p>
                  <p className="text-xs text-muted-foreground">
                    {agent.scannerProfilAktiv === false
                      ? 'Der Scanner-Container läuft derzeit nicht – es kommen keine Scans an.'
                      : 'Der Scanner-Container läuft. Ohne ihn nimmt postbuch.net keine Scans entgegen.'}
                  </p>
                </div>
                {agent.scannerProfilAktiv === false ? (
                  <Button size="sm" onClick={() => profilSchalten.mutate(true)} disabled={profilSchalten.isPending}>
                    {profilSchalten.isPending ? 'Wird geschaltet…' : 'Scannerprofil einschalten'}
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setProfilAusFrage(true)} disabled={profilSchalten.isPending}>
                    Scannerprofil deaktivieren
                  </Button>
                )}
              </div>
              {profilSchalten.isError && <Testergebnis status="fehler">{profilSchalten.error.message}</Testergebnis>}
              {profilSchalten.isSuccess && (
                <Testergebnis status="erfolg">
                  Der Auftrag liegt beim Host-Agenten. Er führt ihn beim nächsten Lauf aus (in der Regel
                  innerhalb einer Minute).
                </Testergebnis>
              )}
            </div>
          )}

          <Dialog open={profilAusFrage} onOpenChange={(o) => { if (!o && !profilSchalten.isPending) setProfilAusFrage(false); }}>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive flex-shrink-0" />Scannerprofil deaktivieren?
            </DialogTitle>
            <DialogDescription className="mt-3">
              Der Scanner-Container wird gestoppt. Gescannte Seiten erreichen postbuch.net danach nicht
              mehr – auch nicht, wenn am Gerät selbst gescannt wird. Die Einstellungen bleiben erhalten
              und lassen sich hier jederzeit wieder einschalten.
            </DialogDescription>
            <DialogFooter>
              <Button variant="outline" onClick={() => setProfilAusFrage(false)} disabled={profilSchalten.isPending}>Abbrechen</Button>
              <Button variant="destructive" onClick={() => profilSchalten.mutate(false)} disabled={profilSchalten.isPending}>
                {profilSchalten.isPending ? 'Wird deaktiviert…' : 'Ja, ich will wirklich nicht mehr scannen'}
              </Button>
            </DialogFooter>
          </Dialog>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Standard-DPI</label>
              <select
                value={form.scanner_default_dpi}
                onChange={(e) => setForm({ ...form, scanner_default_dpi: Number(e.target.value) })}
                className="w-full h-9 text-sm rounded-md border border-input bg-background px-3 focus:outline-none focus:ring-1 focus:ring-ring"
              >
                {[150, 200, 300, 400, 600].map((v) => <option key={v} value={v}>{v} DPI</option>)}
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Standard-Modus</label>
              <select
                value={form.scanner_default_mode}
                onChange={(e) => setForm({ ...form, scanner_default_mode: e.target.value })}
                className="w-full h-9 text-sm rounded-md border border-input bg-background px-3 focus:outline-none focus:ring-1 focus:ring-ring"
              >
                <option value="gray">Graustufen</option>
                <option value="color">Farbe</option>
              </select>
            </div>
          </div>

          {/* Gerätefähigkeiten – bewusst freiwillig. Ohne Ermittlung bleibt
              alles beim bisherigen Verhalten; es gibt hier nichts zu tun. */}
          <div className="space-y-3 pt-1 border-t border-border/50">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Gerätefähigkeiten</p>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="h-8 text-xs"
                disabled={ermitteln.isPending}
                onClick={() => ermitteln.mutate()}
              >
                <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${ermitteln.isPending ? 'animate-spin' : ''}`} />
                {ermitteln.isPending ? 'Frage Gerät ab …' : 'Vom Gerät ermitteln'}
              </Button>
            </div>

            {capabilities ? (
              <div className="space-y-1.5 text-xs">
                <p className="text-muted-foreground">
                  {capabilities.geraet || 'Gerät'} · ermittelt am{' '}
                  {new Date(capabilities.ermitteltAm).toLocaleString('de-DE')}
                </p>
                {Object.entries(capabilities.quellen || {}).map(([quelle, q]) => (
                  <div key={quelle} className="flex flex-wrap gap-x-2 gap-y-0.5">
                    <span className="font-medium w-28">{SCAN_QUELLEN_LABELS[quelle] || quelle}</span>
                    <span className="text-muted-foreground">
                      {q.aufloesungen.join(', ')} dpi · {q.modi.map(m => SCAN_MODUS_LABELS[m] || m).join(', ')}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">
                Noch nicht ermittelt. Der Import-Dialog bietet solange 300 und 600 dpi in
                Graustufen und Farbe an. Eine Ermittlung trägt stattdessen ein, was das
                Gerät je Quelle wirklich kann.
              </p>
            )}

            {ermitteln.isError && (
              <p className="text-xs text-red-600 dark:text-red-400">
                {ermitteln.error?.message || 'Gerät nicht erreichbar'} – der bisherige Stand bleibt erhalten.
              </p>
            )}
            {!capabilitiesPersistiert && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Die geprüfte URL ist noch nicht gespeichert. Speichere zuerst die Scanner-Einstellungen und ermittle die Fähigkeiten anschließend erneut.
              </p>
            )}

            {angewendeteAusstattung && (
              <p className="text-xs text-emerald-600 dark:text-emerald-400">
                Laut Gerät übernommen: ADF {angewendeteAusstattung.scanner_has_adf ? 'vorhanden' : 'nicht vorhanden'} ·
                Duplex {angewendeteAusstattung.scanner_adf_duplex ? 'ja' : 'nein'} ·
                A3 {angewendeteAusstattung.scanner_supports_a3 ? 'ja' : 'nein'}
              </p>
            )}
          </div>

          <div className="space-y-3 pt-1 border-t border-border/50">
            <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Scanner-Ausstattung</p>

            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm font-medium">ADF vorhanden</p>
                <p className="text-xs text-muted-foreground">Aktiviert ADF-Scanoptionen im Import- und Ersetzen-Dialog.</p>
              </div>
              <button
                type="button"
                onClick={() => setForm((prev) => {
                  const nextHasAdf = !prev.scanner_has_adf;
                  return {
                    ...prev,
                    scanner_has_adf: nextHasAdf,
                    scanner_adf_duplex: nextHasAdf ? prev.scanner_adf_duplex : false,
                  };
                })}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${form.scanner_has_adf ? 'bg-primary' : 'bg-muted'}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${form.scanner_has_adf ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>

            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm font-medium">A3 unterstützt</p>
                <p className="text-xs text-muted-foreground">Aktiviert A3 als Papierformat beim Flachbett-Einzelscan.</p>
              </div>
              <button type="button" {...toggle('scanner_supports_a3')} className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${form.scanner_supports_a3 ? 'bg-primary' : 'bg-muted'}`}>
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${form.scanner_supports_a3 ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>

            <div className="flex items-center justify-between py-1">
              <div>
                <p className="text-sm font-medium">ADF duplexfähig</p>
                <p className="text-xs text-muted-foreground">Nur relevant, wenn ADF vorhanden ist. Aktiviert den ADF-Duplex-Scanmodus.</p>
              </div>
              <button
                type="button"
                disabled={!form.scanner_has_adf}
                onClick={() => setForm((prev) => ({ ...prev, scanner_adf_duplex: !prev.scanner_adf_duplex }))}
                className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${form.scanner_adf_duplex ? 'bg-primary' : 'bg-muted'} ${!form.scanner_has_adf ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${form.scanner_adf_duplex ? 'translate-x-6' : 'translate-x-1'}`} />
              </button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* OCR */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">OCR (Texterkennung)</CardTitle>
          <CardDescription className="text-xs pt-1">Gilt für den Cleaner – wird vor jedem Scan-Durchlauf neu gelesen.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between py-1">
            <div>
              <p className="text-sm font-medium">OCR aktiviert</p>
              <p className="text-xs text-muted-foreground">Tesseract-OCR-Textlayer in das PDF einbetten.</p>
            </div>
            <button type="button" {...toggle('cleaner_ocr_enabled')} className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${form.cleaner_ocr_enabled ? 'bg-primary' : 'bg-muted'}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${form.cleaner_ocr_enabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">OCR-Sprachen</label>
            <Input {...field('cleaner_ocr_langs')} placeholder="deu" className="h-9 text-sm font-mono" />
            <p className="text-xs text-muted-foreground">Tesseract-Sprachcodes, z. B. <code className="bg-muted px-1 rounded">deu</code> oder <code className="bg-muted px-1 rounded">deu+eng</code>.</p>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Parallele Kerne (1–8)</label>
            <Input {...numField('cleaner_ocr_jobs')} min={1} max={8} className="h-9 text-sm" />
            <p className="text-xs text-muted-foreground">Anzahl paralleler ocrmypdf-Worker. 2 empfohlen für Raspberry Pi 4.</p>
          </div>
        </CardContent>
      </Card>

      {/* Kalibrierungsassistent – bewusst nach Gerät und OCR als dritte Karte. */}
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2"><Wand2 className="h-5 w-5 text-primary" /><CardTitle className="text-base">Scanner-Kalibrierungsassistent</CardTitle></div>
          <CardDescription className="text-xs pt-1">Mit bis zu drei Test-Scans Leerseitenerkennung und automatischen Zuschnitt live einstellen.</CardDescription>
        </CardHeader>
        <CardContent>
          <Button type="button" onClick={() => window.location.assign('/scanner-kalibrierung/testscans')}>
            Assistent öffnen
          </Button>
        </CardContent>
      </Card>

      {/* Blank-Page-Erkennung */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Leerseiten-Erkennung</CardTitle>
          <CardDescription className="text-xs pt-1">
            Seiten werden anhand von Helligkeit (mean) und Varianz (stddev) als leer erkannt und entfernt.
            Höherer mean-Wert = strenger (nur sehr helle Seiten gelten als leer).
            Niedrigerer stddev-Wert = strenger (nur sehr gleichmäßige Seiten gelten als leer).
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">Mehrseitig (ADF)</p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Helligkeit min.</label>
              <Input {...numField('cleaner_blank_mean_min')} min={0} max={255} className="h-9 text-sm" />
              <p className="text-xs text-muted-foreground">Standard: 240 (0–255)</p>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Varianz max.</label>
              <Input {...numField('cleaner_blank_stddev_max')} min={0} step={0.5} className="h-9 text-sm" />
              <p className="text-xs text-muted-foreground">Standard: 12</p>
            </div>
          </div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider pt-1">Einseitig (Flachbett) – strenger</p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Helligkeit min.</label>
              <Input {...numField('cleaner_blank_mean_min_single')} min={0} max={255} className="h-9 text-sm" />
              <p className="text-xs text-muted-foreground">Standard: 253</p>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Varianz max.</label>
              <Input {...numField('cleaner_blank_stddev_max_single')} min={0} step={0.5} className="h-9 text-sm" />
              <p className="text-xs text-muted-foreground">Standard: 4</p>
            </div>
          </div>
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider pt-1">Duplex-Sicherheitsprüfung</p>
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Nutzinhaltsschwelle</label>
              <Input {...numField('cleaner_blank_content_threshold')} min={0} max={255} className="h-9 text-sm" />
              <p className="text-xs text-muted-foreground">Standard: 200. Niedriger ignoriert mehr helles Durchscheinen.</p>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Nutzpixel max.</label>
              <Input {...numField('cleaner_blank_mask_max_content_px')} min={0} max={1000000} className="h-9 text-sm" />
              <p className="text-xs text-muted-foreground">Standard: 200 bei 100 DPI. Mehr erkannte Pixel erhalten die Seite. Wird automatisch mit der Erkennungs-DPI skaliert.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Crop */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Automatischer Zuschnitt</CardTitle>
          <CardDescription className="text-xs pt-1">Flachbett-Einzelscans und ADF-Duplex-Stapel werden auf Kleinformat (A5/A6) zugeschnitten, wenn der Inhalt passt. Bei Duplex werden die Inhalte beider Seiten gemeinsam berücksichtigt.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center justify-between py-1">
            <div>
              <p className="text-sm font-medium">Zuschnitt aktiviert</p>
              <p className="text-xs text-muted-foreground">Kassenzettel und Kleinformate automatisch zuschneiden.</p>
            </div>
            <button type="button" {...toggle('cleaner_crop_enabled')} className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${form.cleaner_crop_enabled ? 'bg-primary' : 'bg-muted'}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${form.cleaner_crop_enabled ? 'translate-x-6' : 'translate-x-1'}`} />
            </button>
          </div>
          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Erkennungs-DPI</label>
              <Input {...numField('cleaner_detect_dpi')} min={50} max={300} className="h-9 text-sm" />
              <p className="text-xs text-muted-foreground">Standard: 75. Skaliert auch die Störpunkte-Höchstgröße und das Nutzpixel-Maximum mit.</p>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Inhaltsschwelle</label>
              <Input {...numField('cleaner_content_threshold')} min={0} max={255} className="h-9 text-sm" />
              <p className="text-xs text-muted-foreground">Standard: 200 (0–255)</p>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Störpunkte-Höchstgröße</label>
              <Input {...numField('cleaner_content_denoise_min_px')} min={0} max={20} className="h-9 text-sm" />
              <p className="text-xs text-muted-foreground">Standard: 10 Pixel bei 100 DPI (0 = aus). Wird automatisch mit der Erkennungs-DPI skaliert.</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {saveMutation.isError && <p className="text-sm text-destructive">{saveMutation.error?.message}</p>}
      <div className="flex items-center gap-3">
        <Button size="sm" onClick={() => saveMutation.mutate()} disabled={saveMutation.isPending}>
          {saveMutation.isPending ? 'Speichern…' : 'Einstellungen speichern'}
        </Button>
        {saved && <span className="text-xs text-emerald-600 flex items-center gap-1"><CheckCircle className="h-3.5 w-3.5" />Gespeichert – Scanner übernimmt innerhalb 30 s</span>}
      </div>
    </div>
  );
}

// ── Benachrichtigungen Tab ────────────────────────────────────────────────────

function ToggleSwitch({ checked, onChange, disabled }) {
  return (
    <button
      type="button"
      onClick={onChange}
      disabled={disabled}
      className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${checked ? 'bg-primary' : 'bg-muted'}`}
    >
      <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${checked ? 'translate-x-6' : 'translate-x-1'}`} />
    </button>
  );
}

// Fein-granulare Push-Kategorien: must match webpush.js PUSH_CATEGORIES.
const PUSH_CATEGORY_DEFS = [
  { key: 'push_new_doc',        label: 'Neue Dokumente',          icon: FileText,      description: 'Wenn ein Dokument vollständig verarbeitet und abgelegt wurde' },
  { key: 'push_reprocess',      label: 'Wiederverarbeitungen',    icon: RotateCw,      description: 'Wenn ein bestehendes Dokument erneut verarbeitet wurde' },
  { key: 'push_error',          label: 'Verarbeitungsfehler',     icon: AlertOctagon,  description: 'Wenn die Pipeline ein Dokument nicht verarbeiten konnte' },
  { key: 'push_duplicate',      label: 'Duplikat-Verdacht',       icon: Copy,          description: 'Wenn ein möglicher Duplikat-Eintrag gefunden wurde oder aufgelöst wird' },
  { key: 'push_wiedervorlage',  label: 'Wiedervorlagen',          icon: CalendarClock, description: 'Tägliche Erinnerung an fällige Wiedervorlagen' },
  { key: 'push_payment',        label: 'Zahlungsfälligkeiten',    icon: Euro,          description: 'Tägliche Erinnerung an unbezahlte Rechnungen vor Fälligkeit' },
];

function BenachrichtigungenTab() {
  const { isAdmin } = useAuth();
  const qc = useQueryClient();
  const { supported, unsichererKontext, permission, subscribed, erlaubt: pushErlaubt, loading: pushLoading, error: pushError, subscribe, unsubscribe } = usePushSubscription();
  // Nur ein explizites false: solange der Status unbekannt ist, bleibt alles bedienbar.
  const pushAbgeschaltet = pushErlaubt === false;

  const { data: prefs, isLoading: prefsLoading } = useQuery({
    queryKey: ['my-notification-prefs'],
    queryFn: () => pushApi.getMyPrefs(),
  });

  const prefsMutation = useMutation({
    mutationFn: (updates) => pushApi.updateMyPrefs(updates),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['my-notification-prefs'] }),
  });

  const discordEnabled = prefs?.discord ?? true;
  const pushEnabled   = prefs?.push    ?? true;

  // Discord-Konfiguration ist admin-only (Bot-Token/Webhook-URL); der Rest dieses
  // Tabs – die persönlichen Push-Einstellungen – gilt für alle Rollen.
  const { data: discordCfg } = useQuery({ queryKey: ['discord-notifications'], queryFn: () => api.settings.notifications.discord.get(), enabled: isAdmin, retry: false });
  const [discordWebhook, setDiscordWebhook]       = useState('');
  const [discordBotToken, setDiscordBotToken]     = useState('');
  const [discordChannelId, setDiscordChannelId]   = useState('');
  const [discordSaved, setDiscordSaved]           = useState(false);
  const [discordRemoved, setDiscordRemoved]       = useState(false);
  const [showDiscordWebhook, setShowDiscordWebhook]   = useState(false);
  const [showDiscordBotToken, setShowDiscordBotToken] = useState(false);
  const [discordRisikoBestaetigt, setDiscordRisikoBestaetigt] = useState(false);

  useEffect(() => {
    if (discordCfg) {
      setDiscordWebhook('');
      setDiscordBotToken('');
      setDiscordChannelId('');
      setDiscordRemoved(false);
      setDiscordRisikoBestaetigt(false);
    }
  }, [discordCfg]);

  const discordMutation = useMutation({
    mutationFn: () => api.settings.notifications.discord.set(discordWebhook.trim(), discordRisikoBestaetigt),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['discord-notifications'] });
      setDiscordSaved(true);
      setDiscordRemoved(false);
      setDiscordWebhook('');
      setDiscordRisikoBestaetigt(false);
      setTimeout(() => setDiscordSaved(false), 3000);
    },
  });

  const discordRemoveMutation = useMutation({
    mutationFn: () => api.settings.notifications.discord.set(''),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['discord-notifications'] });
      setDiscordRemoved(true);
      setDiscordSaved(false);
      setDiscordWebhook('');
      setTimeout(() => setDiscordRemoved(false), 3000);
    },
  });

  const discordBotMutation = useMutation({
    mutationFn: () => api.settings.notifications.discord.setBot({
      botToken: discordBotToken.trim(),
      channelId: discordChannelId.trim(),
      risikoBestaetigt: discordRisikoBestaetigt,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['discord-notifications'] });
      setDiscordSaved(true);
      setDiscordRemoved(false);
      setDiscordBotToken('');
      setDiscordChannelId('');
      setDiscordRisikoBestaetigt(false);
      setTimeout(() => setDiscordSaved(false), 3000);
    },
  });

  const discordBotRemoveMutation = useMutation({
    mutationFn: () => api.settings.notifications.discord.setBot({ botToken: '', channelId: '' }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['discord-notifications'] });
      setDiscordRemoved(true);
      setDiscordSaved(false);
      setDiscordBotToken('');
      setDiscordChannelId('');
      setTimeout(() => setDiscordRemoved(false), 3000);
    },
  });

  // Lokaler Zustand für Offset + Erinnerungs-Stunde, damit beim Tippen nicht jedes
  // Zeichen eine Mutation auslöst. Sync zu prefs, sobald sie geladen sind.
  const initialOffset = prefs?.push_payment_offset_days ?? 3;
  const [paymentOffset, setPaymentOffset] = useState(initialOffset);
  const [offsetDirty, setOffsetDirty]     = useState(false);
  useEffect(() => {
    if (!offsetDirty && typeof prefs?.push_payment_offset_days === 'number') {
      setPaymentOffset(prefs.push_payment_offset_days);
    }
  }, [prefs?.push_payment_offset_days, offsetDirty]);

  function saveOffset() {
    const n = Number(paymentOffset);
    if (!Number.isInteger(n) || n < 0 || n > 60) return;
    prefsMutation.mutate({ push_payment_offset_days: n }, {
      onSuccess: () => setOffsetDirty(false),
    });
  }

  // Gemeinsame Erinnerungs-Stunde (0..23) für WV + Zahlungen – UI als HH:00.
  const initialHour = prefs?.push_reminder_hour ?? 9;
  const [reminderHour, setReminderHour] = useState(initialHour);
  const [hourDirty, setHourDirty]       = useState(false);
  useEffect(() => {
    if (!hourDirty && typeof prefs?.push_reminder_hour === 'number') {
      setReminderHour(prefs.push_reminder_hour);
    }
  }, [prefs?.push_reminder_hour, hourDirty]);

  function saveReminderHour(value) {
    const v = value ?? reminderHour;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 23) return;
    prefsMutation.mutate({ push_reminder_hour: n }, {
      onSuccess: () => setHourDirty(false),
    });
  }

  // Konvertiert das HH:MM-Eingabefeld zu einer Stunden-Zahl. Minuten werden ignoriert.
  function onHourPickerChange(e) {
    const t = e.target.value; // "HH:MM"
    const h = Number((t || '').split(':')[0]);
    if (Number.isInteger(h) && h >= 0 && h <= 23) {
      setReminderHour(h);
      setHourDirty(true);
    }
  }
  function hourAsTimeValue(h) {
    const hh = String(h).padStart(2, '0');
    return `${hh}:00`;
  }

  return (
    <div className="space-y-6">
      {isAdmin && (
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <BellRing className="h-5 w-5 text-amber-600" />
            <CardTitle className="text-base">Discord</CardTitle>
            <Badge variant="outline" className="border-amber-400 text-amber-700">Experimentell</Badge>
          </div>
          <CardDescription className="text-xs pt-1">Discord wird nicht empfohlen. Nutze stattdessen die PWA-Benachrichtigungen weiter unten.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">
            <div className="flex items-start gap-2">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-700" />
              <div className="space-y-2">
                <p className="font-semibold">Experimentelles Feature – Vorsicht vor Datenoffenlegung</p>
                <p className="text-xs leading-relaxed">
                  Discord erhält Inhalte aus Dokument- und Fehlermeldungen. Ein öffentlicher oder falsch berechtigter Server, Kanal, Bot oder Webhook kann diese Daten für Unbefugte sichtbar machen. Prüfe alle Discord-Berechtigungen und verwende ausschließlich einen privaten Kanal.
                </p>
                <p className="text-xs leading-relaxed">
                  Empfohlen sind <a href="#pwa-benachrichtigungen" className="font-semibold underline underline-offset-2">PWA-Benachrichtigungen</a> ohne Discord-Konfiguration.
                </p>
                <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-amber-300 bg-white/70 p-2 text-xs font-medium">
                  <input
                    type="checkbox"
                    checked={discordRisikoBestaetigt}
                    onChange={(e) => setDiscordRisikoBestaetigt(e.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-amber-700"
                  />
                  <span>Ich habe verstanden, dass Discord experimentell und nicht empfohlen ist und dass eine Fehlkonfiguration sensible Daten offenlegen kann.</span>
                </label>
              </div>
            </div>
          </div>

          <SetupGuideCard
            icon={Bot}
            title="Discord-Bot sauber aufsetzen"
            defaultOpen={false}
            subtitle="Nur verwenden, wenn du das experimentelle Feature trotz der Risiken bewusst einsetzen willst."
            tone="rose"
          >
            <SetupStepList
              steps={[
                <>Auf <span className="font-semibold"><a href="https://discord.com" target="_blank" rel="noopener noreferrer">discord.com</a></span> einen Account anlegen, alle Verifizierungen abschließen und einen neuen Server vom Typ <span className="font-semibold">für mich und meine Freunde</span> erstellen.</>,
                <>Im Server einen Kanal <span className="font-mono">#postbuch</span> verwenden, dessen Einstellungen öffnen und unter <span className="font-semibold">Berechtigungen</span> den <span className="font-semibold">privaten Kanal</span> aktivieren.</>,
                <><span className="font-semibold"><a href="https://discord.com/developers/applications?new_application=true" target="_blank" rel="noopener noreferrer">Developer Portal</a></span> öffnen: <span className="font-mono">https://discord.com/developers/applications?new_application=true</span>. Dort eine neue Anwendung anlegen und den Bot <span className="font-mono">postbuch-notifier</span> erstellen.</>,
                <>Im Bereich <span className="font-semibold">Bot</span> den Token <span className="font-semibold">zurücksetzen</span> und den neuen Token sofort kopieren. Den <span className="font-semibold">Message Content Intent</span> nicht aktivieren – postbuch.net braucht ihn nicht.</>,
                <>Unter <span className="font-semibold">Installation</span> den Installationslink auf <span className="font-semibold">Keine</span> setzen und anschließend im Bot-Bereich <span className="font-semibold">öffentlicher Bot</span> deaktivieren.</>,
                <>Unter <span className="font-semibold">OAuth2</span> im URL-Generator <span className="font-semibold">bot</span> als Anwendungsbereich wählen. Nur <span className="font-semibold">Kanäle ansehen</span>, <span className="font-semibold">Nachrichten senden</span> und <span className="font-semibold">Links einbetten</span> erlauben – niemals Administratorrechte. Dann die generierte URL öffnen und den Bot auf deinem Server autorisieren.</>,
                <>Danach im Kanal <span className="font-mono">#postbuch</span> unten <span className="font-semibold">Mitglieder oder Rollen hinzufügen</span>, den Bot <span className="font-mono">postbuch-notifier</span> auswählen und mit <span className="font-semibold">Fertig</span> bestätigen.</>,
                <>Die <span className="font-semibold">Channel ID</span> ist die Ziffer hinter dem letzten Slash in der Browser-URL, während der Kanal <span className="font-mono">#postbuch</span> geöffnet ist. Genau diesen Wert hier unten eintragen.</>,
              ]}
            />
          </SetupGuideCard>

          <div className="flex items-center gap-2">
            {discordCfg?.mode === 'bot' && <Badge variant="default" className="text-xs">Discord aktiv (Bot-Modus)</Badge>}
            {discordCfg?.mode === 'webhook' && <Badge variant="default" className="text-xs">Discord aktiv (Webhook-Modus)</Badge>}
            {(!discordCfg || discordCfg?.mode === 'none') && <Badge variant="secondary" className="text-xs">Discord deaktiviert</Badge>}
          </div>

          <div className="flex items-center justify-between rounded-lg border border-border/60 p-2.5">
            <div>
              <p className="text-sm font-medium flex items-center gap-2"><Bot className="h-3.5 w-3.5" />Discord-Nachrichten</p>
              <p className="text-xs text-muted-foreground mt-0.5">Bestehende Konfiguration vorübergehend stummschalten</p>
            </div>
            <ToggleSwitch
              checked={discordEnabled}
              onChange={() => prefsMutation.mutate({ discord: !discordEnabled })}
              disabled={prefsMutation.isPending || !discordCfg?.enabled}
            />
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Discord Bot Token</label>
            <div className="relative">
              <Input
                type={showDiscordBotToken ? 'text' : 'password'}
                value={discordBotToken}
                onChange={(e) => setDiscordBotToken(e.target.value)}
                placeholder={discordCfg?.hasBotToken ? '••••••••••••••••' : 'Bot Token eingeben'}
                className="h-9 text-sm font-mono pr-9"
                autoComplete="new-password"
                disabled={!discordRisikoBestaetigt}
              />
              <button type="button" onClick={() => setShowDiscordBotToken(!showDiscordBotToken)} disabled={!discordRisikoBestaetigt} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground disabled:opacity-40">
                {showDiscordBotToken ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Discord Channel ID</label>
            <Input
              value={discordChannelId}
              onChange={(e) => setDiscordChannelId(e.target.value)}
              placeholder={discordCfg?.hasChannelId ? '••••••••••••••••' : 'z. B. 123456789012345678'}
              className="h-9 text-sm font-mono"
              autoComplete="off"
              disabled={!discordRisikoBestaetigt}
            />
            <p className="text-xs text-muted-foreground">Zum Aktivieren müssen Bot-Token und Channel-ID gemeinsam gesetzt sein. Die Channel-ID ist die Zahl hinter dem letzten Slash in der Discord-URL des geöffneten Kanals.</p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm" onClick={() => discordBotMutation.mutate()} disabled={discordBotMutation.isPending || !discordRisikoBestaetigt || !discordBotToken.trim() || !discordChannelId.trim()}>
              {discordBotMutation.isPending ? 'Speichern…' : 'Bot-Modus speichern'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => discordBotRemoveMutation.mutate()} disabled={discordBotRemoveMutation.isPending || !discordCfg?.hasBotConfig}>
              {discordBotRemoveMutation.isPending ? 'Deaktiviere…' : 'Bot-Modus deaktivieren'}
            </Button>
          </div>

          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground uppercase tracking-wider">Discord Webhook URL</label>
            <div className="relative">
              <Input
                type={showDiscordWebhook ? 'text' : 'password'}
                value={discordWebhook}
                onChange={(e) => setDiscordWebhook(e.target.value)}
                placeholder={discordCfg?.enabled ? '••••••••••••••••' : 'https://discord.com/api/webhooks/...'}
                className="h-9 text-sm font-mono pr-9"
                autoComplete="new-password"
                disabled={!discordRisikoBestaetigt}
              />
              <button type="button" onClick={() => setShowDiscordWebhook(!showDiscordWebhook)} disabled={!discordRisikoBestaetigt} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground disabled:opacity-40">
                {showDiscordWebhook ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
            <p className="text-xs text-muted-foreground">Webhook nur setzen, wenn du das experimentelle Feature bewusst nutzen willst. Eine weitergegebene Webhook-URL erlaubt Dritten, Nachrichten in den Zielkanal zu senden.</p>
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <Button size="sm" onClick={() => discordMutation.mutate()} disabled={discordMutation.isPending || !discordRisikoBestaetigt || !discordWebhook.trim()}>
              {discordMutation.isPending ? 'Speichern…' : 'Webhook speichern'}
            </Button>
            <Button size="sm" variant="outline" onClick={() => discordRemoveMutation.mutate()} disabled={discordRemoveMutation.isPending || !discordCfg?.enabled}>
              {discordRemoveMutation.isPending ? 'Deaktiviere…' : 'Discord deaktivieren'}
            </Button>
            {discordSaved && <span className="text-xs text-emerald-600 flex items-center gap-1"><CheckCircle className="h-3.5 w-3.5" />Gespeichert</span>}
            {discordRemoved && <span className="text-xs text-emerald-600 flex items-center gap-1"><CheckCircle className="h-3.5 w-3.5" />Deaktiviert</span>}
          </div>

          {discordMutation.isError && <p className="text-sm text-destructive">{discordMutation.error?.message}</p>}
          {discordRemoveMutation.isError && <p className="text-sm text-destructive">{discordRemoveMutation.error?.message}</p>}
          {discordBotMutation.isError && <p className="text-sm text-destructive">{discordBotMutation.error?.message}</p>}
          {discordBotRemoveMutation.isError && <p className="text-sm text-destructive">{discordBotRemoveMutation.error?.message}</p>}
        </CardContent>
      </Card>
      )}

      {isAdmin && <PushInstanzCard />}

      {/* Push-Abonnement steht bewusst zuerst: die Toggles unten wirken erst,
          wenn dieser Browser tatsächlich als Push-Ziel registriert ist. */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Browser-Abonnement</CardTitle>
          <CardDescription className="text-xs">Dieser Browser abonniert Push-Nachrichten direkt vom Server.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {!supported && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <BellOff className="h-4 w-4 flex-shrink-0" />
              {unsichererKontext
                ? 'Push braucht eine gesicherte Verbindung – diese Seite läuft gerade unverschlüsselt '
                  + 'oder über eine reine IP-Adresse statt über den Hostnamen mit gültigem Zertifikat.'
                : 'Dein Browser unterstützt keine Web-Push-Benachrichtigungen.'}
            </div>
          )}
          {pushAbgeschaltet && (
            <div className="flex items-start gap-2 rounded-lg bg-muted/60 border border-border/60 px-3 py-2.5">
              <BellOff className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-0.5" />
              <p className="text-xs text-muted-foreground">
                {isAdmin
                  ? 'Push ist auf dieser Instanz abgeschaltet (siehe oben). Solange kann niemand abonnieren.'
                  : 'Push-Benachrichtigungen sind auf dieser Instanz vom Admin abgeschaltet.'}
              </p>
            </div>
          )}
          {supported && !pushAbgeschaltet && permission === 'denied' && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2.5">
              <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Benachrichtigungen wurden im Browser blockiert. Bitte in den Browser-Einstellungen erlauben.
              </p>
            </div>
          )}
          {supported && !pushAbgeschaltet && (
            <div className="flex items-center justify-between">
              <div>
                <p className="text-sm font-medium">{subscribed ? 'Abonniert' : 'Nicht abonniert'}</p>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {subscribed ? 'Dieser Browser empfängt Push-Benachrichtigungen.' : 'Klicke auf Abonnieren, um Push-Nachrichten zu aktivieren.'}
                </p>
              </div>
              {subscribed
                ? <Button size="sm" variant="outline" onClick={unsubscribe} disabled={pushLoading}>Deabonnieren</Button>
                : <Button size="sm" onClick={subscribe} disabled={pushLoading || permission === 'denied'}>Abonnieren</Button>}
            </div>
          )}
          {pushError && <p className="text-xs text-destructive">{pushError}</p>}
        </CardContent>
      </Card>

      <Card id="pwa-benachrichtigungen">
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2"><Bell className="h-5 w-5 text-primary" /><CardTitle className="text-base">PWA-Benachrichtigungen <Badge variant="secondary" className="ml-1">Empfohlen</Badge></CardTitle></div>
          <CardDescription className="text-xs pt-1">Aktiviere Browser-Push in der installierten PWA als empfohlenen Benachrichtigungskanal.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {supported && !subscribed && !pushAbgeschaltet && (
            <div className="flex items-start gap-2 rounded-lg bg-amber-500/10 border border-amber-500/30 px-3 py-2.5">
              <AlertTriangle className="h-4 w-4 text-amber-500 flex-shrink-0 mt-0.5" />
              <p className="text-xs text-amber-600 dark:text-amber-400">
                Dieser Browser ist noch nicht abonniert (siehe Karte oben) – die folgenden Einstellungen werden erst nach dem Abonnieren wirksam.
              </p>
            </div>
          )}
          {prefsLoading ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="h-4 w-4" />Lade…</div> : (
            <>
              {/* Push (Master) */}
              <div className="flex items-center justify-between py-1">
                <div>
                  <p className="text-sm font-medium flex items-center gap-2">
                    {pushEnabled ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
                    Browser-Push
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">Hauptschalter – schaltet alle Browser-Push-Benachrichtigungen aus</p>
                </div>
                <ToggleSwitch
                  checked={pushEnabled}
                  onChange={() => prefsMutation.mutate({ push: !pushEnabled })}
                  disabled={prefsMutation.isPending}
                />
              </div>

              {prefsMutation.isError && (
                <p className="text-xs text-destructive">{prefsMutation.error?.message}</p>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Fein-granulare Push-Kategorien */}
      <Card className={pushEnabled ? '' : 'opacity-60'}>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2"><BellRing className="h-5 w-5 text-primary" /><CardTitle className="text-base">Push-Kategorien</CardTitle></div>
          <CardDescription className="text-xs pt-1">
            Wähle, über welche Ereignisse du per Browser-Push benachrichtigt werden möchtest.
            {!pushEnabled && ' Der Hauptschalter Browser-Push ist aus – Push wird derzeit nicht zugestellt.'}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {prefsLoading ? <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="h-4 w-4" />Lade…</div> : (
            <>
              {PUSH_CATEGORY_DEFS.map(({ key, label, icon: Icon, description }) => {
                const enabled = prefs?.[key] ?? true;
                return (
                  <div key={key} className="flex items-center justify-between py-2 border-b border-border/40 last:border-0">
                    <div className="pr-3">
                      <p className="text-sm font-medium flex items-center gap-2"><Icon className="h-3.5 w-3.5 text-muted-foreground" />{label}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{description}</p>
                    </div>
                    <ToggleSwitch
                      checked={enabled}
                      onChange={() => prefsMutation.mutate({ [key]: !enabled })}
                      disabled={prefsMutation.isPending || !pushEnabled}
                    />
                  </div>
                );
              })}

              {/* Gemeinsame Uhrzeit für tägliche Erinnerungen (WV + Zahlungen) */}
              {(() => {
                const wvOn      = prefs?.push_wiedervorlage ?? true;
                const payOn     = prefs?.push_payment ?? true;
                const anyOn     = wvOn || payOn;
                const hourDisabled = prefsMutation.isPending || !pushEnabled || !anyOn;
                return (
                  <div className="pt-3 mt-2 border-t border-border/40 space-y-2">
                    <div className="flex items-center justify-between gap-3 flex-wrap">
                      <div className="min-w-0">
                        <p className="text-sm font-medium flex items-center gap-2"><CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />Uhrzeit tägliche Erinnerungen</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Wann am Tag sollen Wiedervorlagen und Zahlungserinnerungen verschickt werden? (Europe/Berlin, volle Stunden)
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Input
                          type="time"
                          step={3600}
                          value={hourAsTimeValue(reminderHour)}
                          onChange={onHourPickerChange}
                          onBlur={() => saveReminderHour()}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveReminderHour(); } }}
                          disabled={hourDisabled}
                          className="w-28 h-8 text-right"
                        />
                        <span className="text-xs text-muted-foreground">Uhr</span>
                        {hourDirty && (
                          <Button size="sm" variant="outline" onClick={() => saveReminderHour()} disabled={prefsMutation.isPending}>
                            Speichern
                          </Button>
                        )}
                      </div>
                    </div>
                    {!anyOn && (
                      <p className="text-xs text-muted-foreground italic">Aktiviere „Wiedervorlagen“ oder „Zahlungsfälligkeiten“ oben.</p>
                    )}

                    {/* Offset bleibt zahlungsspezifisch – Wiedervorlagen werden immer am Tag der WV verschickt. */}
                    <div className="flex items-center justify-between gap-3 flex-wrap pt-2">
                      <div className="min-w-0">
                        <p className="text-sm font-medium flex items-center gap-2"><CalendarClock className="h-3.5 w-3.5 text-muted-foreground" />Vorlaufzeit Zahlungserinnerung</p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          Wie viele Tage vor Fälligkeit möchtest du an Zahlungen erinnert werden? (0 = am Fälligkeitstag, max. 60). Gilt nur für Zahlungen – Wiedervorlagen werden immer am Tag der WV gesendet.
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Input
                          type="number"
                          min={0}
                          max={60}
                          step={1}
                          value={paymentOffset}
                          onChange={(e) => { setPaymentOffset(e.target.value); setOffsetDirty(true); }}
                          onBlur={saveOffset}
                          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); saveOffset(); } }}
                          disabled={prefsMutation.isPending || !pushEnabled || !payOn}
                          className="w-20 h-8 text-right"
                        />
                        <span className="text-xs text-muted-foreground">Tage</span>
                        {offsetDirty && (
                          <Button size="sm" variant="outline" onClick={saveOffset} disabled={prefsMutation.isPending}>
                            Speichern
                          </Button>
                        )}
                      </div>
                    </div>
                    {!payOn && (
                      <p className="text-xs text-muted-foreground italic">Vorlaufzeit gilt nur, wenn „Zahlungsfälligkeiten“ aktiv ist.</p>
                    )}
                  </div>
                );
              })()}
            </>
          )}
        </CardContent>
      </Card>

    </div>
  );
}

// ── Verbleib Tab ─────────────────────────────────────────────────────────────

// Alle verfügbaren Lucide-Icons extrahieren (ohne interne Utilities und Aliase)
const EXCLUDED_KEYS = new Set([
  'Icon', 'LucideIcon', 'createLucideIcon', 'LucideProvider', 'LucideContext',
  'createElement', 'forwardRef', 'memo', 'default',
]);

const AVAILABLE_ICONS = Object.keys(LucideIcons)
  .filter((key) => {
    // PascalCase-Name, nicht in Ausschlussliste, und keine "Icon"-Suffix-Duplikate
    if (!(/^[A-Z][a-zA-Z0-9]*$/.test(key)) || EXCLUDED_KEYS.has(key)) {
      return false;
    }
    // Lucide exportiert viele Icons als "Name" und "NameIcon" (Alias).
    // Wir wollen nur die Hauptversion ohne "Icon"-Suffix.
    if (key.endsWith('Icon')) {
      // Prüfen, ob es eine Version ohne "Icon" gibt
      const baseName = key.slice(0, -4); // "FolderIcon" → "Folder"
      if (baseName && LucideIcons[baseName]) {
        return false; // Duplikat, überspringen
      }
    }
    return true;
  })
  .sort();

function VerbleibIconPicker({ value, onChange }) {
  const [isOpen, setIsOpen] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const dropdownRef = useRef(null);
  const inputRef = useRef(null);

  // Klick außerhalb schließt das Dropdown
  useEffect(() => {
    function handleClickOutside(event) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target)) {
        setIsOpen(false);
        setSearchTerm('');
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
      return () => document.removeEventListener('mousedown', handleClickOutside);
    }
  }, [isOpen]);

  // Focus auf Input wenn Dropdown öffnet
  useEffect(() => {
    if (isOpen && inputRef.current) {
      inputRef.current.focus();
    }
  }, [isOpen]);

  const SelectedIcon = LucideIcons[value] ?? LucideIcons.FileQuestionMark;
  const valid = Boolean(LucideIcons[value]);

  // Gefilterte Icons basierend auf Suchbegriff
  const filteredIcons = searchTerm
    ? AVAILABLE_ICONS.filter((iconName) =>
        iconName.toLowerCase().includes(searchTerm.toLowerCase())
      )
    : AVAILABLE_ICONS;

  function selectIcon(iconName) {
    onChange(iconName);
    setIsOpen(false);
    setSearchTerm('');
  }

  return (
    <div className="relative" ref={dropdownRef}>
      <button
        type="button"
        onClick={() => setIsOpen(!isOpen)}
        className="w-full flex items-center gap-2 px-2 py-1.5 text-sm border rounded bg-background hover:bg-muted/30 transition-colors"
      >
        <div className="flex items-center justify-center h-6 w-6 rounded border bg-muted/30 flex-shrink-0">
          <SelectedIcon className={['h-4 w-4', valid ? 'text-foreground' : 'text-muted-foreground'].join(' ')} />
        </div>
        <span className="flex-1 text-left font-mono text-sm">{value || 'Icon wählen...'}</span>
        <ChevronDown className="h-4 w-4 text-muted-foreground" />
      </button>

      {isOpen && (
        <div className="absolute z-50 mt-1 w-full rounded-md border bg-popover shadow-lg">
          <div className="p-2 border-b border-border">
            <div className="flex items-center gap-2 px-2 py-1.5 border rounded bg-background">
              <Search className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
              <input
                ref={inputRef}
                type="text"
                placeholder="Icon suchen..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="flex-1 text-sm bg-transparent outline-none"
              />
            </div>
          </div>
          <div className="max-h-[300px] overflow-y-auto p-1">
            {filteredIcons.length === 0 ? (
              <div className="px-2 py-3 text-xs text-center text-muted-foreground">
                Keine Icons gefunden
              </div>
            ) : (
              filteredIcons.map((iconName) => {
                const IconComponent = LucideIcons[iconName];
                const isSelected = iconName === value;
                return (
                  <button
                    key={iconName}
                    type="button"
                    onClick={() => selectIcon(iconName)}
                    className={[
                      'w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm hover:bg-muted/80 transition-colors',
                      isSelected ? 'bg-muted font-medium' : '',
                    ].join(' ')}
                  >
                    <div className="flex items-center justify-center h-5 w-5 flex-shrink-0">
                      <IconComponent className="h-4 w-4 text-foreground" />
                    </div>
                    <span className="flex-1 text-left font-mono text-xs">{iconName}</span>
                    {isSelected && <Check className="h-3.5 w-3.5 text-primary" />}
                  </button>
                );
              })
            )}
          </div>
          <div className="px-2 py-1.5 border-t border-border text-[11px] text-muted-foreground">
            {filteredIcons.length} von {AVAILABLE_ICONS.length} Icons
          </div>
        </div>
      )}
    </div>
  );
}

function VerbleibKategorieRow({ kategorie }) {
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState(kategorie.name);
  const [editIcon, setEditIcon] = useState(kategorie.icon);
  const update = useUpdateVerbleibKategorie();
  const archive = useArchiveVerbleibKategorie();

  function handleSave() {
    update.mutate({ id: kategorie.id, name: editName, icon: editIcon }, {
      onSuccess: () => setEditing(false),
    });
  }

  function handleArchive() {
    if (!window.confirm(
      kategorie.doc_count > 0
        ? `Diese Kategorie ist bei ${kategorie.doc_count} Dokument(en) vergeben. Sie wird als "(veraltet)" markiert und kann nicht mehr neu gewählt werden. Bestehende Zuordnungen bleiben erhalten. Fortfahren?`
        : `Kategorie "${kategorie.name}" archivieren?`
    )) return;
    archive.mutate(kategorie.id);
  }

  const Icon = LucideIcons[kategorie.icon] ?? LucideIcons.FileQuestionMark;

  return (
    <div className={['rounded-md border p-3 space-y-2', kategorie.archived ? 'opacity-50' : ''].join(' ')}>
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-muted-foreground flex-shrink-0" />
        <span className="text-sm flex-1 font-medium">{kategorie.name}</span>
        {kategorie.archived && <Badge variant="outline" className="text-xs text-muted-foreground">veraltet</Badge>}
        {kategorie.doc_count > 0 && !kategorie.archived && (
          <span className="text-xs text-muted-foreground">{kategorie.doc_count} Dok.</span>
        )}
        {!kategorie.archived && !editing && (
          <div className="flex gap-1 ml-auto">
            {kategorie.id !== 1 && (
              <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => { setEditing(true); setEditName(kategorie.name); setEditIcon(kategorie.icon); }}>
                <Pencil className="h-3 w-3" />
              </Button>
            )}
            {kategorie.id !== 1 && (
              <Button size="sm" variant="ghost" className="h-7 px-2 text-muted-foreground hover:text-destructive" onClick={handleArchive} disabled={archive.isPending}>
                <Archive className="h-3 w-3" />
              </Button>
            )}
          </div>
        )}
        {editing && (
          <div className="flex gap-1 ml-auto">
            <Button size="sm" className="h-7 px-2" onClick={handleSave} disabled={update.isPending || !editName.trim()}>
              <Save className="h-3 w-3" />
            </Button>
            <Button size="sm" variant="ghost" className="h-7 px-2" onClick={() => setEditing(false)}>
              <X className="h-3 w-3" />
            </Button>
          </div>
        )}
      </div>
      {editing && (
        <div className="space-y-2 pl-6">
          <input
            className="w-full text-sm border rounded px-2 py-1 bg-background"
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
            placeholder="Name"
          />
          <VerbleibIconPicker value={editIcon} onChange={setEditIcon} />
          {update.isError && <p className="text-xs text-destructive">{update.error?.message}</p>}
        </div>
      )}
    </div>
  );
}

function NewVerbleibKategorieForm({ onDone }) {
  const [name, setName] = useState('');
  const [icon, setIcon] = useState('Folder');
  const create = useCreateVerbleibKategorie();

  function handleSubmit(e) {
    e.preventDefault();
    if (!name.trim()) return;
    create.mutate({ name: name.trim(), icon }, {
      onSuccess: () => { setName(''); setIcon('Folder'); onDone?.(); },
    });
  }

  return (
    <form onSubmit={handleSubmit} className="rounded-md border p-3 space-y-2 bg-muted/20">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Neue Kategorie</p>
      <input
        className="w-full text-sm border rounded px-2 py-1 bg-background"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Name (z. B. Privatarchiv)"
      />
      <VerbleibIconPicker value={icon} onChange={setIcon} />
      <div className="flex items-center gap-2">
        <Button type="submit" size="sm" disabled={create.isPending || !name.trim()}>
          <Plus className="h-3.5 w-3.5 mr-1" />Speichern
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onDone} disabled={create.isPending}>
          <X className="h-3.5 w-3.5 mr-1" />Abbrechen
        </Button>
        {create.isError && <p className="text-xs text-destructive">{create.error?.message}</p>}
      </div>
    </form>
  );
}

function VerbleibTab() {
  const [showNew, setShowNew] = useState(false);
  const { data, isLoading } = useVerbleibKategorienAll();
  const kategorien = data?.data ?? [];
  const aktiv = kategorien.filter((k) => !k.archived);
  const archiviert = kategorien.filter((k) => k.archived);

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex items-center gap-2">
            <Folder className="h-5 w-5 text-primary" />
            <CardTitle className="text-base">Verbleib-Kategorien</CardTitle>
          </div>
          <CardDescription className="text-xs pt-1">
            Kategorien zur Erfassung des physischen Originalverbleibs eines Dokuments. Im Auslieferungszustand sind 5 Basiskategorien vorhanden. Gelöschte Kategorien werden als "(veraltet)" markiert – bestehende Zuordnungen bleiben erhalten.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-2"><Spinner className="h-4 w-4" />Lade…</div>
          ) : (
            <>
              <div className="space-y-1.5">
                {aktiv.map((k) => <VerbleibKategorieRow key={k.id} kategorie={k} />)}
              </div>
              {archiviert.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[11px] font-semibold uppercase text-muted-foreground tracking-wider">Archiviert</p>
                  {archiviert.map((k) => <VerbleibKategorieRow key={k.id} kategorie={k} />)}
                </div>
              )}
              {showNew ? (
                <NewVerbleibKategorieForm onDone={() => setShowNew(false)} />
              ) : (
                <Button size="sm" variant="outline" onClick={() => setShowNew(true)}>
                  <Plus className="h-3.5 w-3.5 mr-1.5" />Neue Kategorie
                </Button>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Drucker Tab ───────────────────────────────────────────────────────────────

function DruckerTab() {
  const { isConnected, deviceName, isPrinting, connect, disconnect } = usePrinter();
  const [connecting, setConnecting] = useState(false);
  const [connectError, setConnectError] = useState(null);
  const [testPrinting, setTestPrinting] = useState(false);
  const [lastResult, setLastResult] = useState(null);

  const { data: settings } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings.getAll(),
    staleTime: 5 * 60 * 1000,
  });

  const { print } = usePrinter();

  const handleConnect = useCallback(async () => {
    setConnecting(true);
    setConnectError(null);
    try {
      await connect();
      setLastResult(null);
    } catch (e) {
      if (e?.name !== 'NotFoundError') {
        setConnectError(e?.message ?? 'Verbindung fehlgeschlagen');
      }
    } finally {
      setConnecting(false);
    }
  }, [connect]);

  const handleDisconnect = useCallback(async () => {
    await disconnect();
    setLastResult(null);
  }, [disconnect]);

  const handleTestPrint = useCallback(async () => {
    setTestPrinting(true);
    setLastResult(null);
    try {
      const instanceName = settings?.instance_name?.value?.trim() ?? '';
      const canvas = await renderLabelCanvas('P000001', { instanceName });
      await print(canvas);
      setLastResult('ok');
    } catch (e) {
      setLastResult(e?.message ?? 'Druckfehler');
    } finally {
      setTestPrinting(false);
    }
  }, [print, settings]);

  const btSupported = typeof navigator !== 'undefined' && 'bluetooth' in navigator;

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Bluetooth className="h-4 w-4 text-primary" />
            Niimbot D110 Etikettendrucker
          </CardTitle>
          <CardDescription>
            Verbindet den Drucker direkt im Browser per Web Bluetooth. Das Etikett wird dann beim
            Klick auf „Etikett drucken" direkt ausgegeben statt heruntergeladen.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {!btSupported && (
            <div className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/30 p-3 text-sm text-amber-800 dark:text-amber-300">
              <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
              <div>
                <strong>Kein Web Bluetooth</strong> – dieser Browser unterstützt die Web Bluetooth
                API nicht. Bitte Chrome, Edge oder Brave verwenden (Android oder Windows).
                Firefox und Safari werden nicht unterstützt.
              </div>
            </div>
          )}

          <div className="flex items-center gap-3 rounded-md border p-3">
            {isConnected ? (
              <BluetoothConnected className="h-5 w-5 text-green-500 flex-shrink-0" />
            ) : connecting ? (
              <BluetoothSearching className="h-5 w-5 text-blue-400 flex-shrink-0 animate-pulse" />
            ) : (
              <BluetoothOff className="h-5 w-5 text-muted-foreground flex-shrink-0" />
            )}
            <div className="flex-1 min-w-0">
              {isConnected ? (
                <p className="text-sm font-medium text-green-600 dark:text-green-400">Verbunden: {deviceName}</p>
              ) : connecting ? (
                <p className="text-sm text-muted-foreground">Gerät wird gesucht…</p>
              ) : (
                <p className="text-sm text-muted-foreground">Nicht verbunden</p>
              )}
              {connectError && (
                <p className="text-xs text-destructive mt-0.5">{connectError}</p>
              )}
            </div>
            {isConnected ? (
              <Button variant="outline" size="sm" onClick={handleDisconnect}>
                Trennen
              </Button>
            ) : (
              <Button size="sm" onClick={handleConnect} disabled={connecting || !btSupported}>
                {connecting ? <Spinner className="h-4 w-4 mr-1.5" /> : null}
                Verbinden
              </Button>
            )}
          </div>

          {isConnected && (
            <div className="flex items-center gap-3">
              <Button
                variant="outline" size="sm"
                onClick={handleTestPrint}
                disabled={testPrinting || isPrinting}
              >
                {testPrinting ? <Spinner className="h-4 w-4 mr-1.5" /> : <Printer className="h-4 w-4 mr-1.5" />}
                Testdruck (P000001)
              </Button>
              {lastResult === 'ok' && (
                <span className="text-xs text-green-600 dark:text-green-400 flex items-center gap-1">
                  <CheckCircle className="h-3.5 w-3.5" /> Erfolgreich gedruckt
                </span>
              )}
              {lastResult && lastResult !== 'ok' && (
                <span className="text-xs text-destructive flex items-center gap-1">
                  <AlertCircle className="h-3.5 w-3.5" /> {lastResult}
                </span>
              )}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Hinweise</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-muted-foreground">
          <p>• Eingelegtes Band: <strong>12×40mm</strong> (schwarze Schrift, weiß, mit Lücken)</p>
          <p>• Browserunterstützung: Chrome, Edge, Brave auf Android und Windows</p>
          <p>• Die Verbindung muss nach jedem Seiten-Reload neu bestätigt werden</p>
          <p>• Beim ersten Verbinden öffnet sich der Browser-Bluetooth-Picker</p>
          <p>• Die Kopplung selbst erfolgt über das Betriebssystem – der D110 muss nicht
             vorab mit dem Gerät gepaart sein, das erledigt der Browser beim ersten Verbinden</p>
        </CardContent>
      </Card>
    </div>
  );
}

// ── MCP Tab (externe KI-Agenten / Claude Desktop) ─────────────────────────────

function McpTab() {
  const qc = useQueryClient();
  const { isAdmin } = useAuth();
  const [description, setDescription] = useState('');
  const [expiresAt, setExpiresAt] = useState('');
  const [newToken, setNewToken] = useState(null); // Klartext, nur einmalig sichtbar
  const [copied, setCopied] = useState(false);

  const { data: tokens = [], isLoading } = useQuery({
    queryKey: ['mcp-tokens'],
    queryFn: () => api.mcpTokens.list(),
  });

  const createMut = useMutation({
    mutationFn: () => api.mcpTokens.create({
      description: description.trim() || undefined,
      expiresAt: expiresAt || undefined,
    }),
    onSuccess: (res) => {
      setNewToken(res.token);
      setCopied(false);
      setDescription('');
      setExpiresAt('');
      qc.invalidateQueries({ queryKey: ['mcp-tokens'] });
    },
  });

  const revokeMut = useMutation({
    mutationFn: (id) => api.mcpTokens.revoke(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['mcp-tokens'] }),
  });

  const mcpUrl = `${window.location.origin}/api/mcp`;

  const copyToken = useCallback(async () => {
    if (!newToken) return;
    try {
      await navigator.clipboard.writeText(newToken);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch { /* Clipboard nicht verfügbar – Nutzer kann manuell markieren */ }
  }, [newToken]);

  const fmt = (v) => (v ? new Date(v).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' }) : '–');

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <Plug className="h-4 w-4 text-primary" />
            MCP-Zugriff (Claude Desktop &amp; andere KI-Agenten)
          </CardTitle>
          <CardDescription>
            Externe KI-Agenten können dein postbuch.net über das Model Context Protocol
            <strong> lesend </strong> befragen: der interne Assistent recherchiert hinter der
            Wand und liefert Antworten samt Quellen; einzelne PDFs lassen sich gezielt laden.
            Zugriff nur mit einem Bearer-Token (unten erzeugen). Schreibzugriff ist bewusst
            nicht möglich.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <div className="flex items-center gap-2 rounded-md border p-3 bg-muted/40">
            <span className="text-muted-foreground shrink-0">Server-URL:</span>
            <code className="text-xs break-all font-mono">{mcpUrl}</code>
          </div>
          <p className="text-xs text-muted-foreground">
            In Claude Desktop als <strong>Custom Connector</strong> (Remote/HTTP) mit obiger URL
            und dem Bearer-Token einrichten. Der Connector stellt zwei Werkzeuge bereit:
            <code className="mx-1">askPostbuch</code> (Frage stellen) und
            <code className="mx-1">getDocument</code> (PDF laden).
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base flex items-center gap-2">
            <KeyRound className="h-4 w-4 text-primary" />
            Neues Token erzeugen
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          {newToken && (
            <div className="rounded-md border border-green-300 bg-green-50 dark:border-green-800 dark:bg-green-950/30 p-3 space-y-2">
              <div className="flex items-start gap-2 text-sm text-green-800 dark:text-green-300">
                <CheckCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
                <div>
                  <strong>Token erzeugt.</strong> Kopiere es jetzt – es wird{' '}
                  <strong>nur dieses eine Mal</strong> angezeigt und kann danach nicht mehr
                  abgerufen werden.
                </div>
              </div>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs break-all font-mono bg-background rounded border p-2">{newToken}</code>
                <Button size="sm" variant="outline" onClick={copyToken}>
                  {copied ? <><Check className="h-4 w-4 mr-1.5" />Kopiert</> : <><Copy className="h-4 w-4 mr-1.5" />Kopieren</>}
                </Button>
              </div>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Beschreibung (optional)</label>
              <Input
                placeholder="z.B. Claude Desktop (Laptop)"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs text-muted-foreground">Ablaufdatum (optional)</label>
              <Input type="date" value={expiresAt} onChange={(e) => setExpiresAt(e.target.value)} />
            </div>
          </div>

          <div className="flex items-center gap-3">
            <Button size="sm" onClick={() => createMut.mutate()} disabled={createMut.isPending}>
              {createMut.isPending ? <Spinner className="h-4 w-4 mr-1.5" /> : <Plus className="h-4 w-4 mr-1.5" />}
              Token erzeugen
            </Button>
            {createMut.isError && (
              <span className="text-xs text-destructive flex items-center gap-1">
                <AlertCircle className="h-3.5 w-3.5" /> {createMut.error?.message || 'Fehler'}
              </span>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">Vorhandene Tokens</CardTitle>
        </CardHeader>
        <CardContent>
          {isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner className="h-4 w-4" /> Lädt…</div>
          ) : tokens.length === 0 ? (
            <p className="text-sm text-muted-foreground">Noch keine Tokens erzeugt.</p>
          ) : (
            <div className="space-y-2">
              {tokens.map((t) => (
                <div key={t.id} className="flex items-center gap-3 rounded-md border p-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium truncate">{t.description || 'Ohne Beschreibung'}</span>
                      {t.active
                        ? <Badge variant="secondary" className="text-[10px]">aktiv</Badge>
                        : <Badge variant="outline" className="text-[10px] text-muted-foreground">widerrufen</Badge>}
                    </div>
                    <div className="text-xs text-muted-foreground mt-0.5 flex flex-wrap gap-x-3">
                      {isAdmin && <span>Nutzer: {t.username}</span>}
                      <span>Erstellt: {fmt(t.created_at)}</span>
                      <span>Zuletzt genutzt: {fmt(t.last_used_at)}</span>
                      {t.expires_at && <span>Läuft ab: {fmt(t.expires_at)}</span>}
                    </div>
                  </div>
                  {t.active && (
                    <Button
                      size="sm" variant="outline"
                      onClick={() => revokeMut.mutate(t.id)}
                      disabled={revokeMut.isPending}
                    >
                      <Trash2 className="h-4 w-4 mr-1.5" /> Widerrufen
                    </Button>
                  )}
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

// ── Settings Tab Bar ──────────────────────────────────────────────────────────

function KontoTab() {
  const { username, isAdmin } = useAuth();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');

  const changeMut = useMutation({
    mutationFn: () => api.auth.changePassword({ oldPassword, newPassword }),
    onSuccess: () => { window.location.href = '/login'; },
    onError: (err) => setError(err.message || 'Passwort konnte nicht geändert werden.'),
  });

  const submit = (event) => {
    event.preventDefault();
    setError('');
    if (!oldPassword || !newPassword) return setError('Bitte alle Passwortfelder ausfüllen.');
    if (newPassword !== confirm) return setError('Neues Passwort und Bestätigung stimmen nicht überein.');
    changeMut.mutate();
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Konto</CardTitle>
        <CardDescription>Angemeldet als {username}</CardDescription>
      </CardHeader>
      <CardContent>
        {isAdmin ? (
          <p className="text-sm text-muted-foreground">
            Das Adminpasswort wird nicht hier geändert, sondern direkt auf dem Server: <code>install.sh</code> erneut ausführen und den Menüpunkt „Adminpasswort ändern" wählen.
          </p>
        ) : (
          <form onSubmit={submit} className="space-y-3 max-w-sm">
            <Input type="password" autoComplete="current-password" placeholder="Aktuelles Passwort"
              value={oldPassword} onChange={(e) => setOldPassword(e.target.value)} />
            <Input type="password" autoComplete="new-password" placeholder="Neues Passwort"
              value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            <Input type="password" autoComplete="new-password" placeholder="Neues Passwort bestätigen"
              value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <Button type="submit" disabled={changeMut.isPending}>
              {changeMut.isPending ? 'Ändere Passwort…' : 'Passwort ändern'}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}

function SettingsTabBar({ tab, onTabChange }) {
  const { isAdmin, canWrite, istEingeschraenkt } = useAuth();
  const adminTabs = [
    { id: 'konto',              label: 'Konto',              icon: KeyRound },
    { id: 'allgemein',          label: 'Allgemein',          icon: Globe    },
    { id: 'ki',                 label: 'KI',                 icon: Bot      },
    { id: 'scanner',            label: 'Scanner',            icon: ScanLine },
    // Die Tab-ID bleibt bewusst 'onedrive': ?tab=onedrive ist verlinkt und
    // steht in Bookmarks/PWA-Verknüpfungen. Nur Beschriftung und Icon ändern
    // sich – Polling, Ordner-Zuordnung und Disaster-Recovery sind seit
    // Phase 2 backend-agnostisch, der alte Name log also bereits.
    // HardDrive statt Cloud: Nextcloud ist ausdrücklich keine Cloud.
    { id: 'onedrive',           label: 'Dateiablage',             icon: HardDrive },
    { id: 'menschen',           label: 'Personen & Zugänge', icon: Users    },
    { id: 'verbleib',           label: 'Verbleib',           icon: Folder   },
    { id: 'drucker',            label: 'Drucker',            icon: Printer  },
    { id: 'mcp',                label: 'MCP-Zugriff',        icon: Plug     },
    { id: 'backup',             label: 'Backup',             icon: Archive  },
    { id: 'benachrichtigungen', label: 'Benachrichtigungen', icon: Bell     },
  ];
  // Nicht-Admins sehen nur „Benachrichtigungen"; Schreibberechtigte zusätzlich „MCP-Zugriff".
  // Konten mit eingeschränktem Lesebereich erhalten keine Benachrichtigungen.
  const visible = new Set(istEingeschraenkt ? ['konto'] : ['konto', 'benachrichtigungen']);
  if (canWrite) visible.add('mcp');
  const tabs = isAdmin ? adminTabs : adminTabs.filter((t) => visible.has(t.id));
  return (
    <div className="flex flex-wrap gap-1 border-b border-border pb-2">
      {tabs.map(({ id, label, icon: Icon }) => (
        <button key={id} onClick={() => onTabChange(id)}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium rounded-md transition-colors whitespace-nowrap
            ${tab === id ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:text-foreground hover:bg-muted'}`}
        >
          <Icon className="h-3.5 w-3.5" />
          {label}
        </button>
      ))}
    </div>
  );
}

// ── Main Page ────────────────────────────────────────────────────────────────

export default function SettingsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { isAdmin, canWrite, istEingeschraenkt } = useAuth();
  const [searchParams, setSearchParams] = useSearchParams();
  const defaultTab = isAdmin ? 'allgemein' : 'konto';
  const angeforderterTab = searchParams.get('tab') || defaultTab;
  const tab = ['personen', 'benutzer'].includes(angeforderterTab) ? 'menschen' : angeforderterTab;

  // Bestehende Bookmarks und alte Wizard-Links bleiben funktionsfähig, landen
  // aber sichtbar auf der einen kanonischen Menschenverwaltung.
  useEffect(() => {
    if (angeforderterTab !== tab) setSearchParams({ tab }, { replace: true });
  }, [angeforderterTab, tab, setSearchParams]);

  // /api/settings ist admin-only; das Ergebnis fließt ausschließlich in Admin-Tabs.
  // Für Nicht-Admins gar nicht erst anfragen, statt einen 403 zu produzieren.
  const { data: settings, isLoading } = useQuery({
    queryKey: ['settings'],
    queryFn: () => api.settings.getAll(),
    enabled: isAdmin,
    retry: false,
  });

  // Nur für die Pille im Kopf. Teilt den Query-Key mit UpdateCard und Sidebar –
  // es entsteht also kein zusätzlicher Request.
  const { data: updateInfo } = useQuery({
    queryKey: ['updates'],
    queryFn: () => api.updates.get(),
    enabled: isAdmin,
    staleTime: 30 * 60 * 1000,
    retry: false,
  });
  const einrichtungOeffnen = useMutation({
    mutationFn: () => api.einrichtung.oeffnen(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['einrichtung'] });
      navigate('/einrichtung/willkommen');
    },
  });

  function refreshAll() {
    qc.invalidateQueries({ queryKey: ['settings'] });
    qc.invalidateQueries({ queryKey: ['onedrive-status'] });
  }

  function setTab(t) { setSearchParams({ tab: t }, { replace: true }); }

  return (
    <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center gap-2">
        <Settings className="h-5 w-5 text-primary" />
        <h1 className="text-xl font-semibold">Einstellungen</h1>
        <DevUnlockVersion isAdmin={isAdmin} />
        {updateInfo?.updateVerfuegbar && (
          <Badge variant="secondary" className="text-[10px]">{updateInfo.verfuegbar} verfügbar</Badge>
        )}
        {isAdmin && (
          <Button variant="outline" size="sm" className="ml-auto h-8" onClick={() => einrichtungOeffnen.mutate()} disabled={einrichtungOeffnen.isPending}>
            <Wand2 className="h-3.5 w-3.5 mr-1.5" />Einrichtung erneut öffnen
          </Button>
        )}
      </div>

      <SettingsTabBar tab={tab} onTabChange={setTab} />

      {tab === 'konto'               && <KontoTab />}
      {tab === 'allgemein'          && isAdmin && <AllgemeinTab />}
      {tab === 'ki'                 && isAdmin && <KITab />}
      {tab === 'scanner'            && isAdmin && <ScannerTab />}
      {tab === 'onedrive'           && isAdmin && <AblageTab settings={settings} isLoading={isLoading} onRefresh={refreshAll} />}
      {tab === 'menschen'           && isAdmin && <MenschenCard />}
      {tab === 'verbleib'           && isAdmin && <VerbleibTab />}
      {tab === 'drucker'            && isAdmin && <DruckerTab />}
      {tab === 'mcp'                && canWrite && <McpTab />}
      {tab === 'backup'             && isAdmin && <BackupTab />}
      {tab === 'benachrichtigungen' && !istEingeschraenkt && <BenachrichtigungenTab />}
    </div>
  );
}


/**
 * Versionsanzeige – und zugleich der einzige Weg zum Dev-Freischaltdialog.
 *
 * Sieben Klicks in fünf Sekunden öffnen nur den Dialog; freigeschaltet wird
 * ausschließlich serverseitig gegen den Dev-Key (POST /api/dev/unlock). Der
 * Einstieg saß früher im Einrichtungsassistenten – dort hatte er nichts zu
 * suchen, weil ein Ersteinrichter keine Dev-Funktionen sucht. Hier steht er
 * da, wo man ihn erwartet: an der Versionsnummer.
 */
function DevUnlockVersion({ isAdmin }) {
  const [offen, setOffen] = useState(false);
  const [devKey, setDevKey] = useState('');
  const klicks = useRef({ anzahl: 0, seit: 0, timer: null });
  const qc = useQueryClient();

  useEffect(() => () => clearTimeout(klicks.current.timer), []);

  const unlock = useMutation({
    mutationFn: () => api.dev.unlock(devKey),
    onSettled: () => setDevKey(''),
    onSuccess: () => {
      setOffen(false);
      qc.invalidateQueries({ queryKey: ['dev-status'] });
      qc.invalidateQueries({ queryKey: ['ai-health'] });
    },
  });

  function klick() {
    if (!isAdmin) return;
    const jetzt = Date.now();
    if (!klicks.current.seit || jetzt - klicks.current.seit > 5000) klicks.current = { anzahl: 0, seit: jetzt, timer: null };
    klicks.current.anzahl += 1;
    clearTimeout(klicks.current.timer);
    klicks.current.timer = setTimeout(() => { klicks.current = { anzahl: 0, seit: 0, timer: null }; }, 5000);
    if (klicks.current.anzahl >= 7) {
      klicks.current = { anzahl: 0, seit: 0, timer: null };
      setOffen(true);
    }
  }

  return (
    <>
      <span
        className="text-xs text-muted-foreground ml-1 select-none"
        onClick={klick}
        title={`postbuch.net ${__APP_VERSION__}`}
      >
        v{__APP_VERSION__}
      </span>
      <Dialog open={offen} onOpenChange={(o) => { setOffen(o); setDevKey(''); }}>
        <DialogTitle className="flex items-center gap-2"><KeyRound className="h-5 w-5" />Dev-Funktionen freischalten</DialogTitle>
        <DialogDescription>
          Der Mehrfachklick entdeckt nur diesen Dialog. Freigeschaltet wird ausschließlich durch die
          serverseitige Schlüsselprüfung.
        </DialogDescription>
        <div className="mt-4">
          <Input type="password" autoComplete="new-password" value={devKey} onChange={(e) => setDevKey(e.target.value)} placeholder="Dev-Key" />
        </div>
        {unlock.isError && <Testergebnis status="fehler">{unlock.error.message}</Testergebnis>}
        <DialogFooter>
          <Button variant="outline" onClick={() => { setOffen(false); setDevKey(''); }}>Abbrechen</Button>
          <Button onClick={() => unlock.mutate()} disabled={!devKey || unlock.isPending}>Freischalten</Button>
        </DialogFooter>
      </Dialog>
    </>
  );
}

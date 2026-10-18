import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { FolderTree } from 'lucide-react';
import { api } from '@/api/client';
import { Input } from '@/components/ui/input';

/** Wurzelangabe „Struktur direkt im App-Ordner“ – gibt es nur im App-Ordner-Modus. */
export const WURZEL_DIREKT = '/';

/**
 * Zugriffsumfang der OneDrive-Verbindung für ein Ablage-Backend.
 * `bereit` ist false, solange der Modus noch nicht feststeht – bis dahin darf
 * keine Vorgabe in das Feld geschrieben werden.
 * @returns {{ bereit: boolean, aktiv: boolean, name: string|null }}
 */
export function useAppOrdner(backend) {
  const istOnedrive = backend === 'onedrive';
  const { data, isPending } = useQuery({
    queryKey: ['onedrive-zugriff'],
    queryFn: () => api.onedrive.zugriff(),
    enabled: istOnedrive,
    retry: false,
  });
  if (!istOnedrive) return { bereit: true, aktiv: false, name: null };
  return { bereit: !isPending, aktiv: data?.modus === 'appordner', name: data?.appOrdnerName || null };
}

/** Vorgabe, solange auf der Instanz noch nichts eingerichtet ist. */
export function standardWurzel(appOrdner) {
  return appOrdner?.aktiv ? WURZEL_DIREKT : 'postbuch';
}

/** Pfad eines Ordners unter der Wurzel, z. B. für `_backup`. */
export function pfadUnterWurzel(wurzel, ordner) {
  return [wurzel === WURZEL_DIREKT ? '' : wurzel, ordner].filter(Boolean).join('/');
}

/** Lesbare Bezeichnung einer Wurzelangabe für Hinweise und Rückfragen. */
export function wurzelLabel(wurzel, appOrdner) {
  if (wurzel !== WURZEL_DIREKT) return wurzel;
  return appOrdner?.name ? `Apps/${appOrdner.name}` : 'direkt im App-Ordner';
}

function AppOrdnerOrt({ name }) {
  return name
    ? <span className="font-mono">Apps/{name}</span>
    : <>deinem App-Ordner unter <span className="font-mono">Apps/</span></>;
}

/**
 * Eingabe des Wurzelordners. Im App-Ordner-Modus liegt die Ablage im
 * Regelfall direkt im App-Ordner; ein eigener Unterordner ist die Ausnahme
 * für mehrere Instanzen mit derselben App-Registrierung und deshalb erst
 * nach einem Klick editierbar.
 */
export function WurzelordnerFeld({ appOrdner, value, onChange, placeholder, className = '', onEnter, ariaLabel = 'Wurzelordner', disabled }) {
  const [unterordner, setUnterordner] = useState(false);
  const imAppOrdner = !!appOrdner?.aktiv;

  if (imAppOrdner && !unterordner && value === WURZEL_DIREKT) {
    return (
      <div className="space-y-1.5">
        <div className="flex items-start gap-2 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
          <FolderTree className="h-4 w-4 flex-shrink-0 mt-0.5 text-muted-foreground" />
          <span>Die Ablage liegt direkt in <AppOrdnerOrt name={appOrdner.name} />.</span>
        </div>
        <button
          type="button"
          className="text-left text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground disabled:opacity-50"
          onClick={() => { setUnterordner(true); onChange(''); }}
          disabled={disabled}
        >
          Stattdessen einen Unterordner verwenden – nur nötig, wenn mehrere Instanzen dieselbe App-Registrierung nutzen
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-1.5">
      <Input
        className={`font-mono ${className}`}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? (imAppOrdner ? 'z. B. instanz-2' : 'postbuch')}
        aria-label={ariaLabel}
        disabled={disabled}
        onKeyDown={onEnter ? (e) => { if (e.key === 'Enter') onEnter(); } : undefined}
      />
      {imAppOrdner && (
        <p className="text-xs text-muted-foreground">
          Unterordner in <AppOrdnerOrt name={appOrdner.name} />.{' '}
          <button
            type="button"
            className="underline underline-offset-2 hover:text-foreground disabled:opacity-50"
            onClick={() => { setUnterordner(false); onChange(WURZEL_DIREKT); }}
            disabled={disabled}
          >
            Direkt in den App-Ordner legen
          </button>
        </p>
      )}
    </div>
  );
}

/**
 * Hinweis nach einer Wiederherstellung: Was weicht vom gesicherten System ab,
 * welche Pflichtprüfungen sind rot, und wie wird es repariert. Steht auf dem
 * Dashboard (nur Admins) und im Willkommen-Schritt des Assistenten, bis der
 * Assistent abgeschlossen oder der Hinweis als erledigt markiert ist.
 */
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArchiveRestore, ArrowRight } from 'lucide-react';
import { api } from '@/api/client';
import { useAuth } from '@/hooks/useAuth';
import { Button } from '@/components/ui/button';

function datum(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

// Prüfungs-ID → Schritt des Assistenten, in dem sie behoben wird
// (gleiche Zuordnung wie SCHRITTE in pages/EinrichtungPage.jsx).
const PRUEFUNG_SCHRITT = {
  betrieb: ['betrieb', 'Instanz'],
  hostAgent: ['betrieb', 'Instanz'],
  menschen: ['menschen', 'Personen'],
  ablage: ['ablage', 'Dateiablage'],
  ordner: ['ordner', 'Ordner'],
  ablageSelbsttest: ['ordner', 'Ordner'],
  kiLlm: ['ki', 'KI'],
  kiEmbedding: ['ki', 'KI'],
  scanner: ['scanner', 'Scanner'],
  backup: ['backup', 'Backup'],
};

export function NachRestoreInhalt({ nachRestore, pflichtOffen = [], pruefungen = {}, imAssistenten = false }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const erledigt = useMutation({
    mutationFn: () => api.einrichtung.nachRestoreErledigt(),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['einrichtung'] }),
  });
  if (!nachRestore) return null;
  const { abweichungen = [] } = nachRestore;
  const schwer = abweichungen.some((a) => a.schwer) || pflichtOffen.length > 0;
  const farbe = schwer
    ? 'border-destructive/30 bg-destructive/8'
    : 'border-amber-500/30 bg-amber-500/8';

  return (
    <div className={`rounded-lg border px-4 py-3 space-y-3 ${farbe}`}>
      <div className="flex items-start gap-3">
        <ArchiveRestore className={`h-4 w-4 mt-0.5 flex-shrink-0 ${schwer ? 'text-destructive' : 'text-amber-600 dark:text-amber-500'}`} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium">Nach der Wiederherstellung noch zu prüfen</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            {nachRestore.am ? `Am ${datum(nachRestore.am)} wurde eine Sicherung eingespielt. ` : ''}
            postbuch.net hat dieses System mit dem gesicherten verglichen.
            {abweichungen.length === 0 && pflichtOffen.length === 0 && ' Es weicht nichts ab.'}
          </p>
        </div>
      </div>

      {pflichtOffen.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium">
            {pflichtOffen.length === 1 ? 'Diese Pflichtprüfung ist rot:' : `Diese ${pflichtOffen.length} Pflichtprüfungen sind rot:`}
          </p>
          <ul className="space-y-2">
            {pflichtOffen.map((id) => {
              const [schritt, label] = PRUEFUNG_SCHRITT[id] || ['willkommen', 'Assistent'];
              return (
                <li key={id} className="rounded-md border bg-background/60 px-3 py-2">
                  <p className="text-xs font-medium">{label}</p>
                  {pruefungen[id]?.text && <p className="mt-0.5 text-xs text-muted-foreground">{pruefungen[id].text}</p>}
                  <Link to={`/einrichtung/${schritt}`} className="mt-1 inline-flex items-center gap-1 text-xs underline underline-offset-2">
                    Zum Schritt „{label}“ <ArrowRight className="h-3 w-3" />
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {abweichungen.length > 0 && (
        <ul className="space-y-2">
          {abweichungen.map((a) => (
            <li key={a.id} className="rounded-md border bg-background/60 px-3 py-2">
              <p className="text-xs font-medium">{a.titel}</p>
              {a.text && <p className="mt-0.5 text-xs text-muted-foreground">{a.text}</p>}
              <p className="mt-1 text-xs">{a.anleitung}</p>
              {a.link && (
                <Link to={a.link} className="mt-1 inline-flex items-center gap-1 text-xs underline underline-offset-2">
                  {a.linkText || 'Dorthin'} <ArrowRight className="h-3 w-3" />
                </Link>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap gap-2">
        {!imAssistenten && (
          <Button size="sm" onClick={() => navigate('/einrichtung/willkommen')}>
            Zum Einrichtungsassistenten
          </Button>
        )}
        <Button size="sm" variant="outline" onClick={() => erledigt.mutate()} disabled={erledigt.isPending}>
          Erledigt – Hinweis ausblenden
        </Button>
      </div>
    </div>
  );
}

export default function NachRestoreHinweis() {
  const { isAdmin } = useAuth();
  const { data } = useQuery({
    queryKey: ['einrichtung'],
    queryFn: () => api.einrichtung.status(),
    enabled: isAdmin,
    staleTime: 60_000,
    retry: false,
  });
  if (!isAdmin || !data?.nachRestore) return null;
  // Weicht nichts vom gesicherten System ab, bleibt das Dashboard ruhig. Rote
  // Pflichtprüfungen allein sind kein Restore-Thema: Sie waren es im gesicherten
  // System schon und stehen im Assistenten.
  if (data.nachRestore.abweichungen.length === 0) return null;
  return <NachRestoreInhalt nachRestore={data.nachRestore} pflichtOffen={data.pflichtOffen} pruefungen={data.pruefungen} />;
}

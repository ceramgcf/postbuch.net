import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/api/client';

export const OFFENE_EINGAENGE_KEY = ['offene-eingaenge'];

const LEER = { verarbeitung: 0, wartet: 0, handlung: 0, duplikatverdacht: 0, briefstapel: 0 };

/**
 * Offene Eingänge – eine Abfrage für Galerie, Dashboard-Karte und den Punkt in
 * der Navigation. Solange etwas verarbeitet wird (oder `schnell` gesetzt ist,
 * etwa nach einer eigenen Aktion) oder ein Dokumentenstapel im Countdown steht, wird
 * alle drei Sekunden nachgefragt, sonst
 * alle 45 Sekunden.
 *
 * Für den Lesebereich „eigene“ ist die Liste gesperrt; die Abfrage wird dort
 * gar nicht gestellt.
 */
export function useOffeneEingaenge({ schnell = false } = {}) {
  const { authenticated, istEingeschraenkt } = useAuth();
  const query = useQuery({
    queryKey: OFFENE_EINGAENGE_KEY,
    queryFn: () => api.eingang.list(),
    enabled: !!authenticated && !istEingeschraenkt,
    retry: false,
    refetchInterval: (q) =>
      (schnell || (q.state.data?.zaehler?.verarbeitung ?? 0) > 0
        || (q.state.data?.eintraege ?? []).some((e) => e.stapel?.automatischAb) ? 3_000 : 45_000),
  });
  return {
    ...query,
    zaehler: query.data?.zaehler ?? LEER,
    eintraege: query.data?.eintraege ?? [],
  };
}

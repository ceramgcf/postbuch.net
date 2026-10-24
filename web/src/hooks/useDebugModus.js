import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';

export const DEBUG_MODUS_KEY = ['debug-mode'];

/**
 * Instanzweiter Debug-Modus (nur Admins schalten ihn, Einstellungen →
 * Allgemein). Liefert `true`, solange er an ist; Diagnosehilfen in der
 * Oberfläche erscheinen nur dann.
 */
export function useDebugModus() {
  const { data } = useQuery({
    queryKey: DEBUG_MODUS_KEY,
    queryFn: () => api.settingsPublic.getDebugMode(),
    staleTime: 60_000,
    retry: false,
  });
  return data?.enabled === true;
}

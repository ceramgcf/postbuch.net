import { useQuery } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { api } from '@/api/client';
import { bildeNavigation } from '@/lib/navigation';
import { useOffeneEingaenge } from '@/hooks/useOffeneEingaenge';
import { istDringend } from '@/lib/eingang';

/**
 * Navigation + Branding-Daten für Sidebar und mobile Kopfleiste.
 * Teilt sich die Query-Keys mit dem Rest der App, löst also keine
 * zusätzlichen Requests aus.
 */
export function useNavigation() {
  const { isAdmin, istEingeschraenkt } = useAuth();

  const { data: personenData } = useQuery({
    queryKey: ['personen'],
    queryFn: () => api.personen.list(),
    staleTime: 5 * 60 * 1000,
  });
  const hasInsuredPerson = (personenData?.data ?? []).some((p) => p.pkv || p.beihilfe);

  const { data: appSettings } = useQuery({
    queryKey: ['settings-public'],
    queryFn: () => api.settingsPublic.getAll(),
    staleTime: 5 * 60 * 1000,
  });
  const navVis = appSettings?.nav_visibility?.value || {};

  // Update-Hinweis nur für Admins: /api/updates ist admin-only, und nur ein
  // Admin kann das Update auslösen – ein Punkt, dem niemand folgen kann, ist Lärm.
  const { data: updateInfo } = useQuery({
    queryKey: ['updates'],
    queryFn: () => api.updates.get(),
    enabled: isAdmin,
    staleTime: 30 * 60 * 1000,
    retry: false,
  });

  // Roter Punkt an „Importieren“: nur, wenn ein Eingang auf den Nutzer wartet.
  const { zaehler } = useOffeneEingaenge();

  return {
    eingangHandlung: istDringend(zaehler),
    ...bildeNavigation({ isAdmin, istEingeschraenkt, navVis, hasInsuredPerson }),
    istEingeschraenkt,
    instanceName: appSettings?.instance_name?.value || '',
    updateVerfuegbar: isAdmin && updateInfo?.updateVerfuegbar === true,
  };
}

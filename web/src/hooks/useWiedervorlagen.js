import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { api } from '../api/client';

export function useWiedervorlagen(params) {
  return useQuery({
    queryKey: ['wiedervorlagen', 'list', params],
    queryFn: () => api.wiedervorlagen.list(params),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}

/**
 * @param {string[]|null} personen  Personenauswahl des Dashboards, null = alle
 * @param {boolean} enabled  false, solange die Auswahl noch nicht feststeht
 */
export function useWiedervorlagenDashboard(personen = null, enabled = true) {
  return useQuery({
    queryKey: ['wiedervorlagen', 'dashboard', personen ?? 'alle'],
    queryFn: () => api.wiedervorlagen.dashboard(personen),
    placeholderData: keepPreviousData,
    enabled,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useWiedervorlagenKalender(von, bis) {
  return useQuery({
    queryKey: ['wiedervorlagen', 'kalender', von, bis],
    queryFn: () => api.wiedervorlagen.kalender(von, bis),
    enabled: !!von && !!bis,
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useCreateWiedervorlage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => api.wiedervorlagen.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wiedervorlagen'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useUpdateWiedervorlage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }) => api.wiedervorlagen.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wiedervorlagen'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useDeleteWiedervorlage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api.wiedervorlagen.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['wiedervorlagen'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

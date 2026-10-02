import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

export function useWiedervorlagen(params) {
  return useQuery({
    queryKey: ['wiedervorlagen', 'list', params],
    queryFn: () => api.wiedervorlagen.list(params),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}

export function useWiedervorlagenDashboard() {
  return useQuery({
    queryKey: ['wiedervorlagen', 'dashboard'],
    queryFn: () => api.wiedervorlagen.dashboard(),
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

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { api } from '../api/client';

export function useVerbleibKategorien() {
  // Verbleib ist für Konten mit eingeschränktem Lesebereich gesperrt.
  const { istEingeschraenkt } = useAuth();
  return useQuery({
    queryKey: ['verbleib', 'list'],
    queryFn: () => api.verbleib.list(),
    staleTime: 5 * 60 * 1000,
    enabled: !istEingeschraenkt,
  });
}

export function useVerbleibKategorienAll() {
  return useQuery({
    queryKey: ['verbleib', 'all'],
    queryFn: () => api.verbleib.listAll(),
    staleTime: 60_000,
  });
}

export function useCreateVerbleibKategorie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => api.verbleib.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['verbleib'] });
    },
  });
}

export function useUpdateVerbleibKategorie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }) => api.verbleib.update(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['verbleib'] });
    },
  });
}

export function useArchiveVerbleibKategorie() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api.verbleib.archive(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['verbleib'] });
    },
  });
}

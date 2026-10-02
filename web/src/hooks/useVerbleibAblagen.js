import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { api } from '../api/client';

const RECENT_KEY = (kategorieId) => `verbleib_recent_${kategorieId}`;
const RECENT_MAX = 3;

export function useVerbleibAblagen(params, { enabled = true } = {}) {
  return useQuery({
    queryKey: ['verbleib', 'ablagen', params],
    queryFn: () => api.verbleib.ablagen.list(params),
    staleTime: 0,
    enabled,
  });
}

export function useCreateVerbleibAblage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => api.verbleib.ablagen.create(data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['verbleib', 'ablagen'] }),
  });
}

export function useUpdateVerbleibAblage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }) => api.verbleib.ablagen.update(id, data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['verbleib', 'ablagen'] }),
  });
}

export function useArchiveVerbleibAblage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api.verbleib.ablagen.archive(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['verbleib', 'ablagen'] }),
  });
}

export function useAufloesen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...data }) => api.verbleib.ablagen.aufloesen(id, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['verbleib', 'ablagen'] });
      qc.invalidateQueries({ queryKey: ['postbuch'] });
    },
  });
}

export function useDeleteVerbleibAblage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api.verbleib.ablagen.delete(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['verbleib', 'ablagen'] }),
  });
}

export function useLoeseKategorieAuf() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => api.verbleib.ablagen.loeseKategorieAuf(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['verbleib', 'ablagen'] });
      qc.invalidateQueries({ queryKey: ['postbuch'] });
    },
  });
}

// localStorage-basierte "zuletzt genutzt"-Liste pro Kategorie
export function useRecentAblagen(kategorieId) {
  const getRecents = useCallback(() => {
    if (!kategorieId) return [];
    try {
      const raw = localStorage.getItem(RECENT_KEY(kategorieId));
      return raw ? JSON.parse(raw) : [];
    } catch {
      return [];
    }
  }, [kategorieId]);

  const addRecent = useCallback((ablageId) => {
    if (!kategorieId || !ablageId) return;
    try {
      const current = getRecents().filter((id) => id !== ablageId);
      current.unshift(ablageId);
      localStorage.setItem(RECENT_KEY(kategorieId), JSON.stringify(current.slice(0, RECENT_MAX)));
    } catch {
      // localStorage nicht verfügbar
    }
  }, [kategorieId, getRecents]);

  return { getRecents, addRecent };
}

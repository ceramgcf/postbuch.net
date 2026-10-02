import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { api } from '../api/client';

export function useAktenList(filters) {
  return useQuery({
    queryKey: ['akten', 'list', filters],
    queryFn: () => api.akten.list(filters),
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}

export function useAkteDetail(akteid) {
  return useQuery({
    queryKey: ['akten', 'detail', akteid],
    queryFn: () => api.akten.get(akteid),
    enabled: !!akteid,
  });
}

export function useCreateAkte() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => api.akten.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['akten'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useUpdateAkte() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ akteid, data }) => api.akten.update(akteid, data),
    onSuccess: (_data, { akteid }) => {
      qc.invalidateQueries({ queryKey: ['akten'] });
      qc.invalidateQueries({ queryKey: ['akten', 'detail', akteid] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useSetAkteHistorisch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ akteid, historisch, auch_dokumente }) =>
      api.akten.setHistorisch(akteid, historisch, auch_dokumente),
    onSuccess: (_data, { akteid }) => {
      qc.invalidateQueries({ queryKey: ['akten'] });
      qc.invalidateQueries({ queryKey: ['akten', 'detail', akteid] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useDeleteAkte() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (akteid) => api.akten.delete(akteid),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['akten'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useAddDocumentToAkte() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ akteid, postid }) => api.akten.addDocument(akteid, postid),
    onSuccess: (_data, { akteid, postid }) => {
      qc.invalidateQueries({ queryKey: ['akten', 'detail', akteid] });
      qc.invalidateQueries({ queryKey: ['akten', 'list'] });
      qc.invalidateQueries({ queryKey: ['akten', 'by-postid', postid] });
      qc.invalidateQueries({ queryKey: ['akten', 'semantic-for-doc', postid] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useRemoveDocumentFromAkte() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ akteid, postid }) => api.akten.removeDocument(akteid, postid),
    onSuccess: (_data, { akteid, postid }) => {
      qc.invalidateQueries({ queryKey: ['akten', 'detail', akteid] });
      qc.invalidateQueries({ queryKey: ['akten', 'list'] });
      qc.invalidateQueries({ queryKey: ['akten', 'by-postid', postid] });
      qc.invalidateQueries({ queryKey: ['akten', 'semantic-for-doc', postid] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useReorderDocuments() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ akteid, order }) => api.akten.reorderDocuments(akteid, order),
    onSuccess: (_data, { akteid }) => {
      qc.invalidateQueries({ queryKey: ['akten', 'detail', akteid] });
    },
  });
}

export function useAktenByPostId(postid) {
  const { istEingeschraenkt } = useAuth();
  return useQuery({
    queryKey: ['akten', 'by-postid', postid],
    queryFn: () => api.akten.byPostId(postid),
    enabled: !!postid && !istEingeschraenkt,
  });
}

export function useRecentAkten() {
  const { istEingeschraenkt } = useAuth();
  return useQuery({
    queryKey: ['akten', 'recent'],
    queryFn: () => api.akten.recent(),
    staleTime: 10_000,
    enabled: !istEingeschraenkt,
  });
}

export function useKiVorschlag() {
  return useMutation({
    mutationFn: (akteid) => api.akten.aiVorschlag(akteid),
  });
}

export function useSemanticAktenSuggestions(postid, enabled) {
  return useQuery({
    queryKey: ['akten', 'semantic-for-doc', postid],
    queryFn: () => api.akten.semanticForDoc(postid),
    enabled: !!postid && !!enabled,
    staleTime: 30_000,
  });
}

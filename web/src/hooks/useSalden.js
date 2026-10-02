import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api/client';

export function useSaldenList() {
  return useQuery({
    queryKey: ['salden', 'list'],
    queryFn: () => api.salden.list(),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}

export function useSaldoDetail(id) {
  return useQuery({
    queryKey: ['salden', 'detail', id],
    queryFn: () => api.salden.get(id),
    enabled: !!id,
  });
}

export function useCreateSaldo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (data) => api.salden.create(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['salden'] });
    },
  });
}

export function useUpdateSaldo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, data }) => api.salden.update(id, data),
    onSuccess: (_data, { id }) => {
      qc.invalidateQueries({ queryKey: ['salden'] });
      qc.invalidateQueries({ queryKey: ['salden', 'detail', id] });
    },
  });
}

export function useDeleteSaldo() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id) => api.salden.delete(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['salden'] });
    },
  });
}

export function useAddBuchung() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ saldoId, data }) => api.salden.addBuchung(saldoId, data),
    onSuccess: (_data, { saldoId }) => {
      qc.invalidateQueries({ queryKey: ['salden'] });
      qc.invalidateQueries({ queryKey: ['salden', 'detail', saldoId] });
    },
  });
}

export function useEditBuchung() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ saldoId, buchungId, data }) => api.salden.editBuchung(saldoId, buchungId, data),
    onSuccess: (_data, { saldoId }) => {
      qc.invalidateQueries({ queryKey: ['salden'] });
      qc.invalidateQueries({ queryKey: ['salden', 'detail', saldoId] });
    },
  });
}

export function useDeleteBuchung() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ saldoId, buchungId }) => api.salden.deleteBuchung(saldoId, buchungId),
    onSuccess: (_data, { saldoId }) => {
      qc.invalidateQueries({ queryKey: ['salden'] });
      qc.invalidateQueries({ queryKey: ['salden', 'detail', saldoId] });
    },
  });
}

export function useAddQuelle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ saldoId, data }) => api.salden.addQuelle(saldoId, data),
    onSuccess: (_data, { saldoId }) => {
      qc.invalidateQueries({ queryKey: ['salden'] });
      qc.invalidateQueries({ queryKey: ['salden', 'detail', saldoId] });
    },
  });
}

export function useEditQuelle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ saldoId, quelleId, data }) => api.salden.editQuelle(saldoId, quelleId, data),
    onSuccess: (_data, { saldoId }) => {
      qc.invalidateQueries({ queryKey: ['salden'] });
      qc.invalidateQueries({ queryKey: ['salden', 'detail', saldoId] });
    },
  });
}

export function useDeleteQuelle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ saldoId, quelleId }) => api.salden.deleteQuelle(saldoId, quelleId),
    onSuccess: (_data, { saldoId }) => {
      qc.invalidateQueries({ queryKey: ['salden'] });
      qc.invalidateQueries({ queryKey: ['salden', 'detail', saldoId] });
    },
  });
}

export function useTestSQL() {
  return useMutation({
    mutationFn: (sql) => api.salden.testSQL(sql),
  });
}

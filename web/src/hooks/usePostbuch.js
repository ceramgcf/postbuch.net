import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query';
import { useAuth } from '@/hooks/useAuth';
import { api } from '../api/client';

export function usePostbuchList(filters) {
  return useQuery({
    queryKey: ['postbuch', 'list', filters],
    queryFn: () => api.postbuch.list(filters),
    placeholderData: keepPreviousData,
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}

export function usePostbuchDetail(postid) {
  return useQuery({
    queryKey: ['postbuch', 'detail', postid],
    queryFn: () => api.postbuch.get(postid),
    enabled: !!postid,
    // EB-Matching läuft nach der Upload-Pipeline asynchron im Hintergrund weiter
    // (service/erstattungsbescheid.js) – solange erstattungsbescheidAusstehend
    // gesetzt ist, automatisch nachladen, bis der Fachblock eintrifft.
    refetchInterval: (query) => query.state.data?.erstattungsbescheidAusstehend ? 4000 : false,
  });
}

export function useUpdatePostbuch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postid, data }) => api.postbuch.update(postid, data),
    onSuccess: (_data, { postid }) => {
      qc.invalidateQueries({ queryKey: ['postbuch'] });
      qc.invalidateQueries({ queryKey: ['postbuch', 'detail', postid] });
      qc.invalidateQueries({ queryKey: ['verbleib', 'ablagen'] });
    },
  });
}

export function useDeletePostbuch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (postid) => api.postbuch.delete(postid),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['postbuch'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
      qc.invalidateQueries({ queryKey: ['analyse'] });
    },
  });
}

export function useUpdateStatus() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postid, status }) => api.postbuch.updateStatus(postid, status),
    onSuccess: (_data, { postid }) => {
      qc.invalidateQueries({ queryKey: ['postbuch'] });
      qc.invalidateQueries({ queryKey: ['postbuch', 'detail', postid] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useMarkPaid() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postid, date }) => api.postbuch.markPaid(postid, date),
    onSuccess: (_data, { postid }) => {
      qc.invalidateQueries({ queryKey: ['postbuch'] });
      qc.invalidateQueries({ queryKey: ['postbuch', 'detail', postid] });
      qc.invalidateQueries({ queryKey: ['analyse'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useReprocess() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postid, instructions, textebeneEntfernen, modelTier }) =>
      api.actions.reprocess(postid, instructions, textebeneEntfernen, modelTier),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['postbuch'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useChangeType() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postid, newL, newD, confirmReprocess }) =>
      api.actions.changeType(postid, newL, newD, confirmReprocess),
    onSuccess: (_data, { postid }) => {
      qc.invalidateQueries({ queryKey: ['postbuch'] });
      qc.invalidateQueries({ queryKey: ['postbuch', 'detail', postid] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useInvalidateRechnung() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postid, confirm }) => api.actions.rechnungInvalidieren(postid, confirm),
    onSuccess: (_data, { postid }) => {
      qc.invalidateQueries({ queryKey: ['postbuch'] });
      qc.invalidateQueries({ queryKey: ['postbuch', 'detail', postid] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useUpdateNote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postid, notiz }) => api.postbuch.update(postid, { notiz: notiz ?? null }),
    onSuccess: (_data, { postid }) => {
      qc.invalidateQueries({ queryKey: ['postbuch', 'detail', postid] });
    },
  });
}

export function useDashboardStats() {
  return useQuery({
    queryKey: ['stats', 'dashboard'],
    queryFn: () => api.stats.dashboard(),
    refetchInterval: 10_000,
    refetchIntervalInBackground: false,
  });
}

export function useUnbezahlt() {
  return useQuery({
    queryKey: ['analyse', 'unbezahlt'],
    queryFn: () => api.analyse.unbezahlt(),
    refetchInterval: 15_000,
    refetchIntervalInBackground: false,
  });
}

export function useKuerzungen(gesehen = 'offen') {
  return useQuery({
    queryKey: ['analyse', 'kuerzungen', gesehen],
    queryFn: () => api.analyse.kuerzungen(gesehen),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function usePerioden() {
  return useQuery({
    queryKey: ['analyse', 'perioden'],
    queryFn: () => api.analyse.perioden(),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function usePeriodenRechnungen(person, kostentraeger, periode) {
  return useQuery({
    queryKey: ['analyse', 'perioden', person, kostentraeger, periode],
    queryFn: () => api.analyse.periodenRechnungen(person, kostentraeger, periode),
    enabled: !!(person && kostentraeger && periode != null),
  });
}

export function useHandwerker() {
  return useQuery({
    queryKey: ['analyse', 'handwerker'],
    queryFn: () => api.analyse.handwerker(),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useFulltextSearch(q, opts = {}) {
  return useQuery({
    queryKey: ['search', 'fulltext', q, opts.historisch],
    queryFn: () => api.search.fulltext(q, opts),
    enabled: !!q && q.length >= 2,
  });
}

export function useSemanticSearch(q) {
  return useQuery({
    queryKey: ['search', 'semantic', q],
    queryFn: () => api.search.semantic(q),
    enabled: false, // Manually triggered
  });
}

export function useCollectingPerioden() {
  const { istEingeschraenkt } = useAuth();
  return useQuery({
    queryKey: ['analyse', 'perioden', 'collecting'],
    queryFn: () => api.analyse.collectingPerioden(),
    staleTime: 30_000,
    enabled: !istEingeschraenkt,
  });
}

export function useSetArztrechnungAP() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postid, kostentraeger, periode }) =>
      api.postbuch.setAP(postid, kostentraeger, periode),
    onSuccess: (_data, { postid }) => {
      qc.invalidateQueries({ queryKey: ['postbuch', 'detail', postid] });
      qc.invalidateQueries({ queryKey: ['analyse'] });
    },
  });
}

export function useSetArztrechnungSatz() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postid, ...data }) => api.postbuch.setSatz(postid, data),
    onSuccess: (_data, { postid }) => {
      qc.invalidateQueries({ queryKey: ['postbuch', 'detail', postid] });
      qc.invalidateQueries({ queryKey: ['analyse'] });
    },
  });
}

export function useUpdateHandwerker() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postid, ...data }) => api.postbuch.updateHandwerker(postid, data),
    onSuccess: (_data, { postid }) => {
      qc.invalidateQueries({ queryKey: ['postbuch', 'detail', postid] });
      qc.invalidateQueries({ queryKey: ['postbuch'] });
      qc.invalidateQueries({ queryKey: ['analyse'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useUpdateArztrechnung() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postid, ...data }) => api.postbuch.updateArztrechnung(postid, data),
    onSuccess: (_data, { postid }) => {
      qc.invalidateQueries({ queryKey: ['postbuch', 'detail', postid] });
      qc.invalidateQueries({ queryKey: ['postbuch'] });
      qc.invalidateQueries({ queryKey: ['analyse'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

// Invalidiert die von einer Erstattungs-Zuordnungsänderung betroffenen Caches:
// das EB-Detail sowie das (alte und neue) Arztrechnungs-Detail und die Auswertungen.
function invalidateZuordnung(qc, ebPostid, data) {
  qc.invalidateQueries({ queryKey: ['postbuch', 'detail', ebPostid] });
  for (const p of [data?.arz_postid, data?.prev_arz_postid]) {
    if (p) qc.invalidateQueries({ queryKey: ['postbuch', 'detail', p] });
  }
  qc.invalidateQueries({ queryKey: ['analyse'] });
  qc.invalidateQueries({ queryKey: ['stats'] });
}

export function useSetErstattungZuordnung() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postid, subid, arzPostid, restoreKuerzungenArzSubid }) => api.postbuch.setErstattungZuordnung(postid, subid, arzPostid, restoreKuerzungenArzSubid),
    onSuccess: (data, { postid }) => invalidateZuordnung(qc, postid, data),
  });
}

export function useAddKuerzung() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postid, subid, data }) => api.postbuch.addKuerzung(postid, subid, data),
    onSuccess: (data, { postid }) => invalidateZuordnung(qc, postid, data),
  });
}

export function useUpdateKuerzung() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postid, kuerzungId, data }) => api.postbuch.updateKuerzung(postid, kuerzungId, data),
    onSuccess: (data, { postid }) => invalidateZuordnung(qc, postid, data),
  });
}

export function useDeleteKuerzung() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postid, kuerzungId }) => api.postbuch.deleteKuerzung(postid, kuerzungId),
    onSuccess: (data, { postid }) => invalidateZuordnung(qc, postid, data),
  });
}

// Invalidiert nach einer Gesehen-/PKV-Prüfvormerkungs-Änderung: das EB-Detail
// (kuerzungId lebt dort), optional die verknüpfte Arztrechnung (falls dort
// mitangezeigt) sowie Kürzungsübersicht/Perioden/Dashboard.
function invalidateKuerzungStatus(qc, postid, arzPostid) {
  qc.invalidateQueries({ queryKey: ['postbuch', 'detail', postid] });
  if (arzPostid) qc.invalidateQueries({ queryKey: ['postbuch', 'detail', arzPostid] });
  qc.invalidateQueries({ queryKey: ['analyse'] });
  qc.invalidateQueries({ queryKey: ['stats'] });
}

export function useSetKuerzungGesehen() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postid, kuerzungId, ebSubid, gesehen }) =>
      api.postbuch.setKuerzungGesehen(postid, kuerzungId, ebSubid, gesehen),
    onSuccess: (_data, { postid, arzPostid }) => invalidateKuerzungStatus(qc, postid, arzPostid),
  });
}

export function useVormerkenPkvPruefung() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postid, kuerzungId, ebSubid, erlaeuterung }) =>
      api.postbuch.vormerkenPkvPruefung(postid, kuerzungId, ebSubid, erlaeuterung),
    onSuccess: (_data, { postid, arzPostid }) => invalidateKuerzungStatus(qc, postid, arzPostid),
  });
}

export function useEntfernePkvPruefung() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postid, kuerzungId, ebSubid }) =>
      api.postbuch.entfernePkvPruefung(postid, kuerzungId, ebSubid),
    onSuccess: (_data, { postid, arzPostid }) => invalidateKuerzungStatus(qc, postid, arzPostid),
  });
}

export function useSetPkvPruefungErlaeuterung() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postid, kuerzungId, ebSubid, erlaeuterung }) =>
      api.postbuch.setPkvPruefungErlaeuterung(postid, kuerzungId, ebSubid, erlaeuterung),
    onSuccess: (_data, { postid, arzPostid }) => invalidateKuerzungStatus(qc, postid, arzPostid),
  });
}

export function useSetOhneRechnungsbezug() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postid, subid, bestaetigt }) => api.postbuch.setOhneRechnungsbezug(postid, subid, bestaetigt),
    onSuccess: (_data, { postid }) => {
      qc.invalidateQueries({ queryKey: ['postbuch', 'detail', postid] });
      qc.invalidateQueries({ queryKey: ['analyse'] });
    },
  });
}

export function useUpdateGenRechnung() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postid, ...data }) => api.postbuch.updateGenRechnung(postid, data),
    onSuccess: (_data, { postid }) => {
      qc.invalidateQueries({ queryKey: ['postbuch', 'detail', postid] });
      qc.invalidateQueries({ queryKey: ['postbuch'] });
      qc.invalidateQueries({ queryKey: ['analyse'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function useDeleteGenRechnungsblock() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (postid) => api.postbuch.deleteGenRechnung(postid),
    onSuccess: (_data, postid) => {
      qc.invalidateQueries({ queryKey: ['postbuch', 'detail', postid] });
      qc.invalidateQueries({ queryKey: ['postbuch'] });
      qc.invalidateQueries({ queryKey: ['analyse'] });
      qc.invalidateQueries({ queryKey: ['stats'] });
    },
  });
}

export function usePins(postid) {
  const { istEingeschraenkt } = useAuth();
  return useQuery({
    queryKey: ['postbuch', 'pins', postid],
    queryFn: () => api.postbuch.listePins(postid),
    enabled: !!postid && !istEingeschraenkt,
  });
}

export function usePinDokument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postid, person, kostentraeger, grund }) =>
      api.postbuch.pinDokument(postid, person, kostentraeger, grund),
    onSuccess: (_data, { postid }) => {
      qc.invalidateQueries({ queryKey: ['postbuch', 'pins', postid] });
      qc.invalidateQueries({ queryKey: ['analyse'] });
    },
  });
}

export function useUnpinDokument() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ postid, person, kostentraeger }) =>
      api.postbuch.unpinDokument(postid, person, kostentraeger),
    onSuccess: (_data, { postid }) => {
      qc.invalidateQueries({ queryKey: ['postbuch', 'pins', postid] });
      qc.invalidateQueries({ queryKey: ['analyse'] });
    },
  });
}

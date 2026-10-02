export const EINRICHTUNG_GATE_QUERY_KEY = ['einrichtung-gate'];

/**
 * Gibt den im Browser gecachten Einrichtungs-Gate-Zustand unmittelbar frei.
 *
 * Beim Assistenten ist die Gate-Query inaktiv. Ein bloßes invalidateQueries()
 * lädt sie deshalb standardmäßig nicht neu und ließ beim anschließenden
 * Routenwechsel kurz den alten Wert `blockiert: true` wirken. Der erfolgreiche
 * Server-Request hat die Freigabe bereits verbindlich bestätigt, daher darf der
 * Client diesen Zustand vor der Navigation synchron spiegeln.
 */
export function einrichtungsGateFreigeben(queryClient, status) {
  queryClient.setQueryData(EINRICHTUNG_GATE_QUERY_KEY, (bisher) => ({
    ...bisher,
    ...(status ? { status } : {}),
    blockiert: false,
    pflichtOffen: [],
  }));

  // Beim nächsten Mount trotzdem serverseitig bestätigen, ohne den gerade
  // korrigierten Cachewert wieder durch eine inaktive Abfrage zu verzögern.
  return queryClient.invalidateQueries({
    queryKey: EINRICHTUNG_GATE_QUERY_KEY,
    refetchType: 'none',
  });
}

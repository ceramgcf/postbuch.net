import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EINRICHTUNG_GATE_QUERY_KEY,
  einrichtungsGateFreigeben,
} from '../src/lib/einrichtung-gate.js';

function queryClientMit(alterWert) {
  return {
    wert: alterWert,
    invalidierung: null,
    setQueryData(queryKey, updater) {
      assert.deepEqual(queryKey, EINRICHTUNG_GATE_QUERY_KEY);
      this.wert = updater(this.wert);
    },
    invalidateQueries(optionen) {
      this.invalidierung = optionen;
      return Promise.resolve();
    },
  };
}

test('erfolgreicher Abschluss entsperrt einen veralteten Gate-Cache vor der Navigation', async () => {
  const queryClient = queryClientMit({ status: 'offen', blockiert: true, pflichtOffen: ['backup'] });

  await einrichtungsGateFreigeben(queryClient, 'abgeschlossen');

  assert.deepEqual(queryClient.wert, {
    status: 'abgeschlossen',
    blockiert: false,
    pflichtOffen: [],
  });
  assert.deepEqual(queryClient.invalidierung, {
    queryKey: EINRICHTUNG_GATE_QUERY_KEY,
    refetchType: 'none',
  });
});

test('Sitzungs-Bypass gibt das Gate auch ohne vorhandenen Cachewert frei', async () => {
  const queryClient = queryClientMit(undefined);

  await einrichtungsGateFreigeben(queryClient, 'offen');

  assert.deepEqual(queryClient.wert, {
    status: 'offen',
    blockiert: false,
    pflichtOffen: [],
  });
});

const BASE = '/api/push';

// Fehlermeldung des Servers übernehmen (z. B. „vom Admin abgeschaltet“),
// statt nur den HTTP-Status zu zeigen.
async function fehlerAus(res) {
  let meldung = `HTTP ${res.status}`;
  try {
    const body = await res.json();
    if (body?.error) meldung = body.error;
  } catch { /* keine JSON-Antwort */ }
  const err = new Error(meldung);
  err.status = res.status;
  return err;
}

async function get(path) {
  const res = await fetch(`${BASE}${path}`, { credentials: 'include', cache: 'no-store' });
  if (!res.ok) throw await fehlerAus(res);
  return res.json();
}

async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await fehlerAus(res);
  return res.json();
}

async function patch(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'PATCH',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw await fehlerAus(res);
  return res.json();
}

export const pushApi = {
  getVapidPublicKey: () => get('/vapid-public'),
  subscribe: (subscription) => post('/subscribe', { subscription }),
  unsubscribe: (endpoint) => post('/unsubscribe', { endpoint }),
  // geraet: SHA-256-Hex des Endpunkts dieses Browsers (optional).
  getSubscriptionStatus: (geraet) => get(`/subscription-status${geraet ? `?geraet=${geraet}` : ''}`),
  getMyPrefs: () => get('/my-prefs'),
  updateMyPrefs: (updates) => patch('/my-prefs', updates),
};

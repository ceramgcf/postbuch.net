/* postbuch.net – Service Worker
   Minimal caching + Web Push support.
*/
const ICON = '/Postbuch-Logo192.png';

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Der fetch-Handler greift ausschließlich beim POST auf /geteilt (Share-Target
// aus dem Manifest). Alle übrigen Anfragen laufen unverändert über den
// Browser: Ein alter, allgemeiner Handler wandelte Netzwerkfehler in
// synthetische 503 um und blieb nach einem Server-Rollback in bereits
// geöffneten Tabs aktiv.

// ── Share-Target: geteilte PDFs entgegennehmen ──────────────────────────────
// Die Dateien landen im Cache-Speicher und werden von der Jobs-Ansicht
// abgeholt (web/src/lib/geteilteDateien.js), die sie wie eine Dateiauswahl
// in die Pipeline gibt. Der Nutzer muss dafür angemeldet sein – das prüft
// erst die Seite, deshalb der Umweg über den Cache statt eines Direkt-Uploads.
// Ist postbuch.net beim Teilen nicht erreichbar, nimmt der Service-Worker die
// Datei gar nicht erst an, sondern meldet das laut mit einer eigenen Seite.
// Die PDF wird verworfen und muss später erneut geteilt werden – eine still
// im Browser wartende Datei bliebe sonst leicht unbemerkt liegen.
const GETEILT_CACHE = 'postbuch-geteilt';
const ERREICHBAR_TIMEOUT_MS = 5000;

async function serverErreichbar() {
  const abbruch = new AbortController();
  const timer = setTimeout(() => abbruch.abort(), ERREICHBAR_TIMEOUT_MS);
  try {
    const res = await fetch('/api/health', { cache: 'no-store', signal: abbruch.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const NICHT_ERREICHBAR_SEITE = `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#7c3aed">
<title>postbuch.net nicht erreichbar</title>
<style>
  :root { color-scheme: light dark; --bg: #f7f5fb; --karte: #ffffff; --text: #1f1b2e; --leise: #5f5a70; --akzent: #7c3aed; --rand: #e4def0; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #14111c; --karte: #1d1928; --text: #ece9f4; --leise: #a7a1b8; --akzent: #a78bfa; --rand: #2e2840; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
         padding: 16px; background: var(--bg); color: var(--text);
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
  main { max-width: 26rem; width: 100%; background: var(--karte); border: 1px solid var(--rand);
         border-radius: 16px; padding: 24px; }
  h1 { font-size: 1.15rem; margin: 0 0 12px; }
  p { margin: 0 0 12px; color: var(--leise); }
  a { display: inline-block; margin-top: 8px; color: var(--akzent); font-weight: 600; text-decoration: none; }
</style>
</head>
<body>
<main>
  <h1>postbuch.net ist nicht erreichbar</h1>
  <p>Der Server hat nicht geantwortet. Die geteilte PDF konnte deshalb nicht entgegengenommen werden und wurde verworfen.</p>
  <p>Prüfe die Verbindung zu postbuch.net und teile die PDF danach erneut.</p>
  <a href="/">postbuch.net öffnen</a>
</main>
</body>
</html>`;

async function nimmGeteilteDateienAn(request) {
  if (!(await serverErreichbar())) {
    return new Response(NICHT_ERREICHBAR_SEITE, {
      status: 503,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }
  let anzahl = 0;
  try {
    const form = await request.formData();
    const dateien = form.getAll('pdf').filter((f) => f && typeof f === 'object' && f.size > 0);
    const cache = await caches.open(GETEILT_CACHE);
    const stempel = Date.now();
    for (let i = 0; i < dateien.length; i++) {
      const f = dateien[i];
      await cache.put(`/__geteilt/${stempel}-${i}`, new Response(f, {
        headers: {
          'Content-Type': f.type || 'application/pdf',
          'X-Dateiname': encodeURIComponent(f.name || `geteilt-${i + 1}.pdf`),
        },
      }));
      anzahl++;
    }
  } catch (err) {
    console.warn('[sw] Geteilte Dateien konnten nicht übernommen werden:', err);
  }
  return Response.redirect(anzahl > 0 ? '/logs?geteilt=1' : '/logs?geteilt=fehler', 303);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'POST') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname !== '/geteilt') return;
  event.respondWith(nimmGeteilteDateienAn(request));
});

// ── Push-Empfang ─────────────────────────────────────────────────────────────
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); } catch {
    data = { title: 'postbuch.net', body: event.data.text() };
  }

  const isDuplicate = (data.tag || '').startsWith('dup-') && !(data.tag || '').startsWith('dup-resolved');

  event.waitUntil(
    self.registration.showNotification(data.title || 'postbuch.net', {
      body: data.body || '',
      icon: ICON,
      badge: ICON,
      tag: data.tag,
      requireInteraction: !!data.requireInteraction || isDuplicate,
      // Dupliziert-Benachrichtigungen: roter Hintergrund über vibrate-Signal betonen
      vibrate: isDuplicate ? [200, 100, 200, 100, 400] : [200],
      data: {
        url: data.url || '/',
      },
    }),
  );
});

// ── Klick auf Benachrichtigung → App öffnen / navigieren ────────────────────
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = new URL(
    event.notification.data?.url || '/',
    self.location.origin,
  ).href;

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      if (windows.length > 0) {
        const w = windows[0];
        if ('navigate' in w) {
          return w.navigate(targetUrl).then((nw) => (nw || w).focus());
        }
        w.focus();
        w.postMessage({ type: 'SW_NAVIGATE', url: targetUrl });
        return;
      }
      return self.clients.openWindow(targetUrl);
    }),
  );
});

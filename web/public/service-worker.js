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

// Absichtlich KEIN fetch-Handler: Alle Anfragen laufen unverändert über den
// Browser. Ein alter Handler wandelte Netzwerkfehler in synthetische 503 um
// und blieb nach einem Server-Rollback in bereits geöffneten Tabs aktiv.

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

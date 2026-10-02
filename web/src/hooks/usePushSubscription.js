// usePushSubscription – verwaltet den Web-Push-Abo-Status für postbuch.net
//
// Ablauf:
// 1. Prüfe ob Browser Push unterstützt + Notification-Permission
// 2. Lade VAPID Public Key vom Backend
// 3. Abonniere via pushManager.subscribe()
// 4. Speichere Subscription im Backend
//
// Der angezeigte Status ist der Abgleich Browser ↔ Server (Query 'push-status'):
// „abonniert" nur, wenn dieser Browser ein Abo hat UND der Server genau dieses
// Gerät für den angemeldeten Nutzer kennt. Hat der Admin Push instanzweit
// abgeschaltet, sind serverseitig alle Abos gelöscht; das dann nutzlose
// Browser-Abo wird hier lokal mit abgeräumt.

import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { pushApi } from '@/api/push';

async function sha256Hex(text) {
  if (!globalThis.crypto?.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

async function ermittleStatus() {
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  let antwort = null;
  try {
    antwort = await pushApi.getSubscriptionStatus(sub ? await sha256Hex(sub.endpoint) : null);
  } catch {
    // Server nicht erreichbar: nur den Browserstand anzeigen, nichts abräumen.
    return { erlaubt: null, abonniert: !!sub };
  }
  const erlaubt = antwort.erlaubt !== false;
  if (sub && !erlaubt) {
    try { await sub.unsubscribe(); } catch { /* Browser-Abo bleibt wirkungslos stehen */ }
    sub = null;
  }
  return { erlaubt, abonniert: !!sub && antwort.geraetBekannt !== false };
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

export function usePushSubscription() {
  // 'serviceWorker' in navigator ist in einem unsicheren Kontext (HTTP über
  // reine IP statt Hostname, kein gültiges Zertifikat) grundsätzlich false —
  // auch in Chrome, das Web Push sonst vollständig unterstützt. `supported`
  // allein kann diese beiden Ursachen nicht unterscheiden, deshalb getrennt
  // als `unsichererKontext` melden: sonst suggeriert die Meldung fälschlich
  // ein Browser-Problem, wo eigentlich nur https bzw. der Hostname fehlt.
  const unsichererKontext = typeof window !== 'undefined' && window.isSecureContext === false;
  const supported = typeof window !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && 'Notification' in window;

  const [permission, setPermission] = useState(
    supported ? Notification.permission : 'denied',
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const qc = useQueryClient();

  const { data: status } = useQuery({
    queryKey: ['push-status'],
    queryFn: ermittleStatus,
    enabled: supported,
    retry: false,
  });
  const subscribed = !!status?.abonniert;
  // null = unbekannt (Server nicht erreichbar oder noch nicht geladen).
  const erlaubt = status ? status.erlaubt : null;

  // Nach jeder Änderung: eigener Status, Admin-Empfängerliste, Cloudfrei-Check.
  const aktualisieren = useCallback(() => Promise.all([
    qc.invalidateQueries({ queryKey: ['push-status'] }),
    qc.invalidateQueries({ queryKey: ['webpush-instanz'] }),
    qc.invalidateQueries({ queryKey: ['cloudfrei-check'] }),
  ]), [qc]);

  const subscribe = useCallback(async () => {
    if (!supported) return;
    setLoading(true);
    setError(null);
    try {
      // 1. Notification-Permission anfragen
      const perm = await Notification.requestPermission();
      setPermission(perm);
      if (perm !== 'granted') {
        setError('Benachrichtigungen wurden verweigert. Bitte in den Browser-Einstellungen erlauben.');
        return;
      }

      // 2. VAPID Public Key laden
      const { publicKey } = await pushApi.getVapidPublicKey();
      if (!publicKey) throw new Error('VAPID-Key nicht verfügbar');

      // 3. Service Worker + pushManager.subscribe()
      const reg = await navigator.serviceWorker.ready;
      const vorher = await reg.pushManager.getSubscription();
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      });

      // 4. Subscription im Backend speichern. Scheitert das, ein eben erst
      // angelegtes Browser-Abo wieder entfernen – ein bereits vorhandenes
      // (etwa eines anderen Kontos in diesem Browser) bleibt unangetastet.
      try {
        await pushApi.subscribe(sub.toJSON());
      } catch (err) {
        if (!vorher) { try { await sub.unsubscribe(); } catch { /* ignorieren */ } }
        throw err;
      }
    } catch (err) {
      console.error('[usePushSubscription] subscribe Fehler:', err);
      setError(err.message || 'Push-Abonnement fehlgeschlagen');
    } finally {
      await aktualisieren();
      setLoading(false);
    }
  }, [supported, aktualisieren]);

  const unsubscribe = useCallback(async () => {
    if (!supported) return;
    setLoading(true);
    setError(null);
    try {
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.getSubscription();
      if (sub) {
        await pushApi.unsubscribe(sub.endpoint);
        await sub.unsubscribe();
      }
    } catch (err) {
      console.error('[usePushSubscription] unsubscribe Fehler:', err);
      setError(err.message || 'Abmeldung fehlgeschlagen');
    } finally {
      await aktualisieren();
      setLoading(false);
    }
  }, [supported, aktualisieren]);

  return {
    supported,
    unsichererKontext,
    permission,
    subscribed,
    erlaubt,
    loading,
    error,
    subscribe,
    unsubscribe,
  };
}

/**
 * App-Installation (PWA) über das Browserereignis `beforeinstallprompt`.
 *
 * Chromium-Browser (Chrome, Edge, Android) melden per `beforeinstallprompt`,
 * dass sich die Seite als App installieren lässt. Das Ereignis kommt früh und
 * nur einmal je Seitenaufruf; deshalb fängt `pwaInstallationBeobachten()` es
 * schon beim Start (main.jsx) ab und hält es hier fest. Oberflächen fragen den
 * Zustand über `usePwaInstallation()` ab. Firefox und Safari kennen das
 * Ereignis nicht – dort bleibt `installierbar` falsch und kein Knopf erscheint.
 */
import { useSyncExternalStore } from 'react';

let aufschub = null; // gespeichertes beforeinstallprompt-Ereignis
let installiert = false;
const hoerer = new Set();

function melden() {
  zustand = berechnen();
  hoerer.forEach((h) => h());
}

export function laeuftAlsApp() {
  if (typeof window === 'undefined') return false;
  const mm = (q) => window.matchMedia?.(q).matches;
  return !!(mm('(display-mode: standalone)') || mm('(display-mode: fullscreen)')
    || mm('(display-mode: minimal-ui)') || window.navigator?.standalone === true);
}

function berechnen() {
  const alsApp = installiert || laeuftAlsApp();
  return { installierbar: !!aufschub && !alsApp, alsApp };
}

let zustand = berechnen();

export function pwaInstallationBeobachten() {
  if (typeof window === 'undefined') return;
  window.addEventListener('beforeinstallprompt', (e) => {
    // Browsereigene Leiste unterdrücken, Aufforderung für den eigenen Knopf aufheben.
    e.preventDefault();
    aufschub = e;
    melden();
  });
  window.addEventListener('appinstalled', () => {
    installiert = true;
    aufschub = null;
    melden();
  });
}

/**
 * Zeigt den Installationsdialog des Browsers. Liefert 'accepted', 'dismissed'
 * (abgelehnt oder Fenster geschlossen) oder null, wenn keine Abfrage bereitlag.
 */
export async function pwaInstallieren() {
  const e = aufschub;
  if (!e) return null;
  aufschub = null; // jedes Ereignis lässt sich nur einmal verwenden
  melden();
  try {
    await e.prompt();
    const { outcome } = await e.userChoice;
    if (outcome === 'accepted') { installiert = true; melden(); return 'accepted'; }
  } catch { /* Browser hat abgelehnt – Knopf bleibt weg bis zum nächsten Ereignis */ }
  return 'dismissed';
}

function abonnieren(h) { hoerer.add(h); return () => hoerer.delete(h); }

export function usePwaInstallation() {
  return useSyncExternalStore(abonnieren, () => zustand, () => zustand);
}

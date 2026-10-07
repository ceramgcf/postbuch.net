/**
 * useGemerkteFilter – merkt die URL-Filter einer Auswertungsseite je Browser und Benutzer.
 *
 * Gespeichert werden die Suchparameter der Seite. Jahreszahlen im Parameter
 * `jahre` werden relativ zum aktuellen Jahr abgelegt (0 = dieses Jahr, 1 = Vorjahr)
 * und beim Laden wieder in absolute Jahre zurückgerechnet: Die Auswahl „dieses und
 * letztes Jahr" wandert so zum Jahreswechsel von selbst mit.
 */
import { useEffect } from 'react';
import { useAuth } from '@/hooks/useAuth';

const PREFIX = 'filter:';
const JAHR = /^\d{4}$/;

const aktuellesJahr = () => new Date().getFullYear();

function schluessel(seite, username) {
  return username ? `${PREFIX}${seite}:${username}` : null;
}

function jahreRelativ(jahre) {
  const jetzt = aktuellesJahr();
  return jahre.split(',').map((j) => (JAHR.test(j) ? `~${jetzt - Number(j)}` : j)).join(',');
}

function jahreAbsolut(jahre, verfuegbar) {
  const jetzt = aktuellesJahr();
  return jahre.split(',')
    .map((j) => (/^~-?\d+$/.test(j) ? String(jetzt - Number(j.slice(1))) : j))
    .filter((j) => verfuegbar.includes(j));
}

/**
 * @param {string} seite  Schlüssel der Seite (z. B. 'handwerker')
 * @param {URLSearchParams} searchParams  aktuelle Parameter der Seite
 * @returns {{ laden: (verfuegbareJahre: string[]) => URLSearchParams|null }}
 *   `laden` liefert die gemerkten Parameter (Jahre bereits auf heute umgerechnet)
 *   oder null, wenn nichts Brauchbares gespeichert ist.
 */
export function useGemerkteFilter(seite, searchParams) {
  const { username } = useAuth();
  const key = schluessel(seite, username);
  const aktuell = searchParams.toString();

  // Erst speichern, wenn Jahre gesetzt sind – sonst überschreibt der leere
  // Anfangszustand die gemerkte Auswahl, bevor sie wiederhergestellt wurde.
  useEffect(() => {
    if (!key) return;
    const params = new URLSearchParams(aktuell);
    const jahre = params.get('jahre');
    if (!jahre) return;
    params.set('jahre', jahreRelativ(jahre));
    try { localStorage.setItem(key, params.toString()); } catch { /* privater Modus: gilt nur bis zum Neuladen */ }
  }, [key, aktuell]);

  const laden = (verfuegbareJahre) => {
    if (!key) return null;
    try {
      const roh = localStorage.getItem(key);
      if (!roh) return null;
      const params = new URLSearchParams(roh);
      const jahre = jahreAbsolut(params.get('jahre') || '', verfuegbareJahre);
      if (jahre.length === 0) return null;
      params.set('jahre', jahre.join(','));
      return params;
    } catch {
      return null;
    }
  };

  return { laden };
}

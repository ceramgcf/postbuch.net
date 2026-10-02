/**
 * middleware/lesebereich.js — eingeschränkter Lesebereich („nur eigene Dokumente“)
 *
 * Ein Lesezugriff mit mensch.lesebereich = 'eigene' sieht ausschließlich
 * Dokumente, deren familienmitglied exakt sein Kurzname ist.
 *
 * Durchsetzung in zwei Stufen:
 *   1. lesebereichGate — Positivliste auf Endpunktebene. Alles, was nicht
 *      ausdrücklich freigegeben ist, liefert 403. Neue Routen sind damit für
 *      diese Rolle automatisch gesperrt. Endpunkte mit :postid prüfen die
 *      Sichtbarkeit des Dokuments hier zentral (fremd → 404).
 *   2. eigeneDokumenteBedingung() — SQL-Bedingung für die freigegebenen
 *      Listen- und Suchendpunkte.
 *
 * Kurzname und Lesebereich werden pro Request frisch aus postbuch.mensch
 * gelesen und nicht in der Session gecacht: Eine Umbenennung oder Änderung
 * wirkt sofort, ohne dass eine veraltete Session weiterfiltern kann.
 */
import { query } from '../db.js';

const POSTID = 'P\\d{6}';

/**
 * Freigegebene Endpunkte, relativ zu /api. `postid: true` heißt: die erste
 * Capture-Gruppe ist eine PostID, deren Dokument sichtbar sein muss.
 * Ausschließlich GET — schreibende Methoden sperrt für lesezugriff ohnehin
 * die globale Write-Protection.
 */
const FREIGABEN = [
  { pfad: /^\/postbuch\/?$/ },
  { pfad: new RegExp(`^/postbuch/(${POSTID})/?$`), postid: true },
  { pfad: new RegExp(`^/files/(${POSTID})/pdf(?:/fetch|/fetch-progress)?/?$`), postid: true },
  { pfad: /^\/search\/?$/ },
  { pfad: /^\/search\/semantic\/?$/ },
  { pfad: /^\/personen\/?$/ },
  { pfad: /^\/taxonomie\/?$/ },
  { pfad: /^\/settings-public\/?$/ },
  { pfad: /^\/settings-public\/einrichtung-gate\/?$/ },
];

/**
 * Lädt den Lesebereich der Sitzung. Nur Rolle lesezugriff kann eingeschränkt
 * sein; admin und vollzugriff sehen immer alles.
 * @returns {Promise<{eingeschraenkt:boolean, kurzname?:string}|null>}
 *   null = Sitzung gehört zu keinem aktiven Zugang mehr (fail-closed).
 */
async function ladeLesebereich(req) {
  if (req.session?.role !== 'lesezugriff') return { eingeschraenkt: false };
  const r = await query(
    `SELECT kurzname, lesebereich FROM postbuch.mensch
      WHERE loginfaehig AND aktiv
        AND (id::text = $1 OR ($1 IS NULL AND anmeldename = $2))`,
    [req.session.menschId ?? null, req.session.username ?? null],
  );
  if (!r.rowCount) return null;
  const { kurzname, lesebereich } = r.rows[0];
  return lesebereich === 'alle' ? { eingeschraenkt: false } : { eingeschraenkt: true, kurzname };
}

export async function lesebereichGate(req, res, next) {
  let lb;
  try {
    lb = await ladeLesebereich(req);
  } catch (err) {
    console.error('[lesebereich] Prüfung fehlgeschlagen:', err.message);
    return res.status(403).json({ error: 'Kein Zugriff' });
  }
  if (!lb) return res.status(403).json({ error: 'Kein Zugriff' });
  if (!lb.eingeschraenkt) return next();

  req.lesebereich = { kurzname: lb.kurzname };
  const treffer = req.method === 'GET'
    && FREIGABEN.map((f) => ({ f, m: f.pfad.exec(req.path) })).find(({ m }) => m);
  if (!treffer) return res.status(403).json({ error: 'Kein Zugriff' });

  if (treffer.f.postid) {
    try {
      const r = await query(
        'SELECT 1 FROM postbuch.postbuch WHERE postid = $1 AND familienmitglied = $2',
        [treffer.m[1], lb.kurzname],
      );
      if (!r.rowCount) return res.status(404).json({ error: 'Dokument nicht gefunden' });
    } catch (err) {
      console.error('[lesebereich] Dokumentprüfung fehlgeschlagen:', err.message);
      return res.status(403).json({ error: 'Kein Zugriff' });
    }
  }
  next();
}

/** Ist die Anfrage auf eigene Dokumente beschränkt? (nur nach lesebereichGate gültig) */
export function istEingeschraenkt(req) {
  return !!req.lesebereich;
}

/**
 * SQL-Bedingung „nur eigene Dokumente“ für eine familienmitglied-Spalte.
 * Hängt den Kurznamen an params an und liefert die Bedingung, oder null,
 * wenn die Anfrage nicht eingeschränkt ist.
 *
 * @param {object} req
 * @param {string} spalte  z. B. 'p.familienmitglied'
 * @param {Array}  params  Parameterliste der Query (wird erweitert)
 * @returns {string|null}
 */
export function eigeneDokumenteBedingung(req, spalte, params) {
  if (!req.lesebereich) return null;
  params.push(req.lesebereich.kurzname);
  return `${spalte} = $${params.length}`;
}

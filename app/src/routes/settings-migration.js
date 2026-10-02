/**
 * routes/settings-migration.js — REST-API für die Ablage-Migration
 *
 * WICHTIG: Dieser Router wird als Sub-Router INNERHALB von routes/settings.js
 * montiert (`router.use('/storage/migration', migrationRouter)`), nicht als
 * eigener Top-Level-Mount in index.js. Damit erbt er requireAdmin strukturell
 * und kann es nicht durch eine spätere Umsortierung in index.js verlieren.
 *
 * Eine Migration ist eine Betreiber-Entscheidung — es gibt keine Route hier,
 * die ein vollzugriff-Nutzer erreichen darf.
 *
 * Endpunkte (alle unter /api/settings/storage/migration):
 *   GET    /aktuell                  → offener Lauf oder null (UI-Einstieg)
 *   POST   /trockenlauf              { src, dst } — erfasst immer den gesamten Bestand
 *   GET    /:runId                   → Lauf-Status + Item-Zähler
 *   GET    /:runId/restliste
 *   POST   /:runId/start             → startet oder setzt fort
 *   POST   /:runId/abbrechen         → pausiert (fortsetzbar, NICHT der Rückbau unten)
 *   POST   /:runId/abbrechen-vollstaendig → EIN Klick, egal in welchem Schritt:
 *                                     hält ggf. an und rollt sofort zurück; bei
 *                                     aktivem Worker erst {phase:'wird_angehalten'},
 *                                     danach erneut aufrufen
 *   POST   /:runId/abschliessen      → „Trotzdem abschließen"
 *   POST   /:runId/rest/:postid/erneut
 *   POST   /:runId/rest/:postid/ohne-datei
 *   POST   /:runId/rest/:postid/loeschen   { confirm: true }
 *   GET    /:runId/rueckbau          → Vorschau (zählt, baut nicht zurück)
 *   POST   /:runId/rueckbau          { confirm: true, erwarteteAnzahl } — dreht bereits
 *                                     kopierte Items dieses Laufs zurück auf die Quelle
 *   GET    /:runId/aufraeumen        → Vorschau (zählt, räumt nicht)
 *   POST   /:runId/aufraeumen        { confirm: true, erwarteteAnzahl } — läuft im
 *                                     Hintergrund, Antwort ist { runId, jobId }
 *   POST   /:runId/abschliessen-ohne-aufraeumen — überspringt das Aufräumen dauerhaft
 *   POST   /umschalten               { ziel, confirm: true } — blockiert bei offenen Nachzüglern
 *   GET    /:runId/nachzuegler       → zählt neu im Quell-Backend aufgetauchte Dokumente
 *   POST   /:runId/nachzuegler       → hängt sie als Items an, Lauf → 'pausiert'
 */

import { Router } from 'express';
import * as migration from '../service/storage-migration.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POSTID_RE = /^P\d{6}$/;

/** Wirft 400 statt eines 500ers aus dem uuid-Cast. */
function runId(req, res) {
  const v = String(req.params.runId || '');
  if (!UUID_RE.test(v)) { res.status(400).json({ error: 'Ungültige Lauf-ID' }); return null; }
  return v;
}

function postId(req, res) {
  const v = String(req.params.postid || '');
  if (!POSTID_RE.test(v)) { res.status(400).json({ error: 'Ungültige Postbuch-ID' }); return null; }
  return v;
}

/** Einheitliche Fehlerausgabe — statusCode aus dem Service, sonst 500. */
function fehler(res, err, kontext) {
  const code = err?.statusCode || 500;
  if (code >= 500) console.error(`[settings-migration] ${kontext}:`, err);
  res.status(code).json({
    error: err?.message || 'Interner Fehler',
    ...(err?.code && code < 500 ? { code: err.code } : {}),
    ...(err?.postid ? { postid: err.postid } : {}),
    ...(err?.erstattungsbescheide ? { erstattungsbescheide: err.erstattungsbescheide } : {}),
    ...(err?.hinweis ? { hinweis: err.hinweis } : {}),
    ...(err?.nachzuegler ? { nachzuegler: err.nachzuegler } : {}),
  });
}

router.get('/aktuell', async (_req, res) => {
  try {
    res.json(await migration.getOffenenLauf());
  } catch (err) { fehler(res, err, 'aktuell'); }
});

// Schritt 1: Ordnerstruktur im Ziel anlegen. Legt nur an, verschiebt nichts.
router.post('/ziel-vorbereiten', async (req, res) => {
  try {
    const { backend, rootPath } = req.body || {};
    const p = String(rootPath || 'postbuch').trim();
    if (p.length > 200 || p.includes('..')) {
      return res.status(400).json({ error: 'Ungültiger Stammpfad' });
    }
    res.json(await migration.bereiteZielVor(backend, p));
  } catch (err) { fehler(res, err, 'ziel-vorbereiten'); }
});

router.post('/trockenlauf', async (req, res) => {
  try {
    // Ein Trockenlauf erfasst immer den gesamten Quellbestand — ein `limit`
    // aus einem alten, gecachten Frontend-Bundle wird stillschweigend
    // ignoriert statt mit 400 abgewiesen.
    const { src, dst } = req.body || {};
    res.json(await migration.trockenlauf({ src, dst }));
  } catch (err) { fehler(res, err, 'trockenlauf'); }
});

router.get('/:runId', async (req, res) => {
  const id = runId(req, res); if (!id) return;
  try {
    const run = await migration.getRun(id);
    if (!run) return res.status(404).json({ error: 'Lauf nicht gefunden' });
    res.json(run);
  } catch (err) { fehler(res, err, 'getRun'); }
});

router.get('/:runId/restliste', async (req, res) => {
  const id = runId(req, res); if (!id) return;
  try {
    res.json(await migration.getRestliste(id));
  } catch (err) { fehler(res, err, 'restliste'); }
});

router.post('/:runId/start', async (req, res) => {
  const id = runId(req, res); if (!id) return;
  try {
    res.json(await migration.starteLauf(id));
  } catch (err) { fehler(res, err, 'start'); }
});

// Abbruch NUR hier — /api/jobs/:id/cancel prüft keine Rolle, deshalb läuft der
// Migrationsjob mit cancellable: false.
router.post('/:runId/abbrechen', async (req, res) => {
  const id = runId(req, res); if (!id) return;
  try {
    const ok = migration.brichAb();
    res.json({ ok, hinweis: ok
      ? 'Abbruch angefordert. Bereits kopierte Dateien bleiben auf beiden Ablagen, nichts wird gelöscht.'
      : 'Es läuft gerade keine Migration.' });
  } catch (err) { fehler(res, err, 'abbrechen'); }
});

// Universeller Abbruch für die UI: EIN Button, in jedem Schritt vor dem
// Umschalten erreichbar. Braucht kein confirm — die Frontend-Seite holt die
// Bestätigung vorher ein, weil sich der Text je nach Fortschritt unterscheidet.
router.post('/:runId/abbrechen-vollstaendig', async (req, res) => {
  const id = runId(req, res); if (!id) return;
  try { res.json(await migration.brichLaufVollstaendigAb(id)); }
  catch (err) { fehler(res, err, 'abbrechen-vollstaendig'); }
});

router.post('/:runId/abschliessen', async (req, res) => {
  const id = runId(req, res); if (!id) return;
  try {
    res.json(await migration.laufAbschliessen(id));
  } catch (err) { fehler(res, err, 'abschliessen'); }
});

// ── Restlisten-Auflösung ─────────────────────────────────────────────────────

router.post('/:runId/rest/:postid/erneut', async (req, res) => {
  const id = runId(req, res); if (!id) return;
  const pid = postId(req, res); if (!pid) return;
  try { res.json(await migration.restErneutVersuchen(id, pid)); }
  catch (err) { fehler(res, err, 'rest/erneut'); }
});

router.post('/:runId/rest/:postid/ohne-datei', async (req, res) => {
  const id = runId(req, res); if (!id) return;
  const pid = postId(req, res); if (!pid) return;
  try { res.json(await migration.restOhneDatei(id, pid)); }
  catch (err) { fehler(res, err, 'rest/ohne-datei'); }
});

router.post('/:runId/rest/:postid/loeschen', async (req, res) => {
  const id = runId(req, res); if (!id) return;
  const pid = postId(req, res); if (!pid) return;
  if (req.body?.confirm !== true) {
    return res.status(400).json({ error: 'confirm: true erforderlich' });
  }
  try { res.json(await migration.restEintragLoeschen(id, pid)); }
  catch (err) { fehler(res, err, 'rest/loeschen'); }
});

// ── Rückbau ──────────────────────────────────────────────────────────────────
//
// Bewusst eigener Name, nicht dasselbe wie /:runId/abbrechen oben: „abbrechen"
// pausiert nur den laufenden Worker (fortsetzbar, nichts wird zurückgedreht).
// „rueckbau" dreht bereits kopierte Items dieses Laufs zurück auf die Quelle —
// nur solange pausiert, nicht umgeschaltet und nicht aufgeräumt (Details im
// Kopfkommentar von service/storage-migration.js).

router.get('/:runId/rueckbau', async (req, res) => {
  const id = runId(req, res); if (!id) return;
  try {
    const v = await migration.rueckbauVorschau(id);
    const { alle, ...oeffentlich } = v;
    res.json(oeffentlich);
  } catch (err) { fehler(res, err, 'rueckbau/vorschau'); }
});

router.post('/:runId/rueckbau', async (req, res) => {
  const id = runId(req, res); if (!id) return;
  const { confirm, erwarteteAnzahl } = req.body || {};
  if (confirm !== true) {
    return res.status(400).json({ error: 'confirm: true erforderlich' });
  }
  if (!Number.isInteger(erwarteteAnzahl) || erwarteteAnzahl < 0) {
    return res.status(400).json({ error: 'erwarteteAnzahl (ganze Zahl) erforderlich' });
  }
  try { res.json(await migration.rolleLaufZurueck(id, erwarteteAnzahl)); }
  catch (err) { fehler(res, err, 'rueckbau'); }
});

// ── Schritt 6: Quelle aufräumen ──────────────────────────────────────────────

router.get('/:runId/aufraeumen', async (req, res) => {
  const id = runId(req, res); if (!id) return;
  try {
    const v = await migration.aufraeumenVorschau(id);
    // `alle` ist die interne Arbeitsmenge und kann Tausende Einträge haben.
    const { alle, ...oeffentlich } = v;
    res.json(oeffentlich);
  } catch (err) { fehler(res, err, 'aufraeumen/vorschau'); }
});

router.post('/:runId/aufraeumen', async (req, res) => {
  const id = runId(req, res); if (!id) return;
  const { confirm, erwarteteAnzahl } = req.body || {};
  if (confirm !== true) {
    return res.status(400).json({ error: 'confirm: true erforderlich' });
  }
  // Scope-Pinning: ohne die erwartete Anzahl räumte eine veraltete UI-Ansicht
  // Zeilen mit, die der Nutzer nie gesehen hat.
  if (!Number.isInteger(erwarteteAnzahl) || erwarteteAnzahl < 0) {
    return res.status(400).json({ error: 'erwarteteAnzahl (ganze Zahl) erforderlich' });
  }
  try { res.json(await migration.raeumeQuelleAuf(id, erwarteteAnzahl)); }
  catch (err) { fehler(res, err, 'aufraeumen'); }
});

// Für Nutzer, die das Aufräumen der Quelle dauerhaft überspringen wollen —
// eigener Endpunkt statt eines confirm-Flags auf /aufraeumen, weil hier
// bewusst NICHT dieselbe erwarteteAnzahl-Prüfung greift (es wird ja nichts
// bewegt).
router.post('/:runId/abschliessen-ohne-aufraeumen', async (req, res) => {
  const id = runId(req, res); if (!id) return;
  try { res.json(await migration.schliesseOhneAufraeumenAb(id)); }
  catch (err) { fehler(res, err, 'abschliessen-ohne-aufraeumen'); }
});

// ── Schritt 4: Umschalten ────────────────────────────────────────────────────

router.post('/umschalten', async (req, res) => {
  const { ziel, confirm } = req.body || {};
  if (confirm !== true) {
    return res.status(400).json({ error: 'confirm: true erforderlich' });
  }
  try { res.json(await migration.schalteBackendUm(ziel)); }
  catch (err) { fehler(res, err, 'umschalten'); }
});

// ── Nachzügler ────────────────────────────────────────────────────────────────

router.get('/:runId/nachzuegler', async (req, res) => {
  const id = runId(req, res); if (!id) return;
  try { res.json(await migration.ermittleNachzuegler(id)); }
  catch (err) { fehler(res, err, 'nachzuegler/vorschau'); }
});

router.post('/:runId/nachzuegler', async (req, res) => {
  const id = runId(req, res); if (!id) return;
  try { res.json(await migration.nachzueglerAufnehmen(id)); }
  catch (err) { fehler(res, err, 'nachzuegler'); }
});

export default router;

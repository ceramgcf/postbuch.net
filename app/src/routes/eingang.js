/**
 * routes/eingang.js – Eingangsgalerie: offene Eingänge ansehen und behandeln
 *
 * Liegt hinter requireAuth, lesebereichGate und der globalen Schreibsperre:
 * Lesen dürfen admin, vollzugriff und lesezugriff mit Lesebereich „alle“;
 * schreibende Methoden sind für lesezugriff gesperrt. Für den Lesebereich
 * „eigene“ gibt es keine Freigabe – Eingänge gehören noch keiner Person.
 *
 * Der Client sendet nur den Eintragsschlüssel. Er ist keine Berechtigung:
 * Jede Route schlägt die Quelle neu nach.
 *
 * Dokumentenstapel (service/stapel.js) haben eigene Routen unter /stapel/:id. Sie
 * stehen vor den allgemeinen Routen, damit /:schluessel/… sie nicht schluckt:
 *   GET  /stapel/:id                  Trennansicht (Blätter, Vorschlag, Aufteilung)
 *   GET  /stapel/:id/seite/:seq/:s    Seitenbild (JPEG), ?gross=1 für die Großansicht
 *   POST /stapel/:id/anhalten         Countdown der Übernahme ohne Rückfrage anhalten
 *   POST /stapel/:id/uebernehmen      { trennungen, entfernt } → Dokumente einreihen
 *   POST /stapel/:id/neu-vorschlagen  KI erneut fragen
 *   POST /stapel/:id/verwerfen        Stapel samt Blättern löschen
 */

import { Router } from 'express';
import {
  leseEingaenge, oeffentlich, zaehle, findeEingang, istSchluessel, verbleibVon,
  ladePdf, vorschauSchluessel, loeseNeuAus, legeManuellAb, verwirf, KonfliktError,
} from '../service/offene-eingaenge.js';
import { holeVorschau, VorschauUeberlastetError } from '../service/eingang-vorschau.js';
import { pruefeManuelleErfassung } from '../service/manuelle-erfassung.js';
import { appLog } from '../app-log.js';
import * as stapel from '../service/stapel.js';

const router = Router();

function benutzer(req) {
  return req.session?.username || req.session?.user || req.session?.role || null;
}

function fehlerAntwort(res, err, kontext) {
  if (err instanceof KonfliktError) return res.status(409).json({ error: err.message });
  if (err.status && err.status >= 400 && err.status < 600) {
    return res.status(err.status).json({ error: err.message });
  }
  console.error(`${kontext} error:`, err);
  appLog('ERROR', 'eingang', `${kontext}: ${err.message}`);
  return res.status(500).json({ error: 'Interner Serverfehler' });
}

async function nichtGefunden(res, schluessel) {
  const { postid, weiter, fehler, teile } = await verbleibVon(schluessel);
  return res.status(404).json({
    ...(teile ? { teile } : {}),
    error: teile?.length
      ? `Dieser Dokumentenstapel ist aufgeteilt: ${teile.length === 1 ? 'Ein Dokument wurde' : `${teile.length} Dokumente wurden`} übergeben.`
      : fehler
      ? `Dieser Lauf ist fehlgeschlagen: ${fehler} Im Eingang ist dazu nichts mehr offen.`
      : postid
      ? `Dieser Eingang ist inzwischen als Dokument ${postid} abgelegt.`
      : weiter
        ? 'Dieser Eingang steht inzwischen unter einem neuen Stand im Eingang.'
        : 'Zu diesem Eintrag gibt es im Eingang nichts mehr zu tun: Er wurde bereits erledigt oder verworfen.',
    postid,
    ...(weiter ? { weiter } : {}),
    ...(fehler ? { fehlgeschlagen: true } : {}),
  });
}

// ── Dokumentenstapel ──────────────────────────────────────────────────────────────

function stapelId(req, res) {
  const id = String(req.params.id || '').toLowerCase();
  if (!stapel.istStapelId(id)) {
    res.status(400).json({ error: 'Ungültige Dokumentenstapel-ID' });
    return null;
  }
  return id;
}

router.get('/stapel/:id', async (req, res) => {
  try {
    const id = stapelId(req, res);
    if (!id) return;
    const d = await stapel.detail(id);
    if (!d || d.status === 'erledigt') return nichtGefunden(res, `t:${id}`);
    res.json(d);
  } catch (err) {
    fehlerAntwort(res, err, 'GET /api/eingang/stapel/:id');
  }
});

router.get('/stapel/:id/seite/:seq/:seite', async (req, res) => {
  try {
    const id = stapelId(req, res);
    if (!id) return;
    const seq = /^\d{1,3}$/.test(req.params.seq) ? Number(req.params.seq) : NaN;
    const seite = /^[12]$/.test(req.params.seite) ? Number(req.params.seite) : NaN;
    const bild = await stapel.seitenbild(id, seq, seite, req.query.gross === '1');
    res.set({
      'Content-Type': 'image/jpeg',
      'Content-Length': bild.length,
      'Cache-Control': 'private, max-age=300',
    });
    res.send(bild);
  } catch (err) {
    if (err instanceof VorschauUeberlastetError) {
      return res.status(503).set('Retry-After', '5').json({ error: err.message });
    }
    if (err.status === 400 || err.status === 404) return res.status(err.status).json({ error: err.message });
    console.warn(`[eingang] Seitenbild nicht erzeugt: ${err.message}`);
    res.status(404).json({ error: 'Keine Vorschau verfügbar' });
  }
});

router.post('/stapel/:id/anhalten', async (req, res) => {
  try {
    const id = stapelId(req, res);
    if (!id) return;
    res.json({ ok: true, angehalten: await stapel.anhalten(id) });
  } catch (err) {
    fehlerAntwort(res, err, 'POST /api/eingang/stapel/anhalten');
  }
});

router.post('/stapel/:id/uebernehmen', async (req, res) => {
  try {
    const id = stapelId(req, res);
    if (!id) return;
    res.json({ ok: true, ...(await stapel.uebernehmen(id, req.body, benutzer(req))) });
  } catch (err) {
    fehlerAntwort(res, err, 'POST /api/eingang/stapel/uebernehmen');
  }
});

router.post('/stapel/:id/neu-vorschlagen', async (req, res) => {
  try {
    const id = stapelId(req, res);
    if (!id) return;
    await stapel.neuVorschlagen(id);
    res.json({ ok: true });
  } catch (err) {
    fehlerAntwort(res, err, 'POST /api/eingang/stapel/neu-vorschlagen');
  }
});

router.post('/stapel/:id/verwerfen', async (req, res) => {
  try {
    const id = stapelId(req, res);
    if (!id) return;
    await stapel.verwerfen(id, benutzer(req));
    res.json({ ok: true });
  } catch (err) {
    fehlerAntwort(res, err, 'POST /api/eingang/stapel/verwerfen');
  }
});

// GET /api/eingang – alle offenen Eingänge mit Zählern je Gruppe
router.get('/', async (req, res) => {
  try {
    const eintraege = await leseEingaenge();
    res.json({ zaehler: zaehle(eintraege), eintraege: eintraege.map(oeffentlich) });
  } catch (err) {
    fehlerAntwort(res, err, 'GET /api/eingang');
  }
});

// GET /api/eingang/:schluessel – ein Eingang
router.get('/:schluessel', async (req, res) => {
  try {
    const { schluessel } = req.params;
    if (!istSchluessel(schluessel)) return res.status(400).json({ error: 'Ungültiger Schlüssel' });
    const e = await findeEingang(schluessel);
    if (!e) return nichtGefunden(res, schluessel);
    res.json(oeffentlich(e));
  } catch (err) {
    fehlerAntwort(res, err, 'GET /api/eingang/:schluessel');
  }
});

// GET /api/eingang/:schluessel/vorschau – Seite 1 als JPEG
router.get('/:schluessel/vorschau', async (req, res) => {
  try {
    const e = await findeEingang(req.params.schluessel);
    if (!e) return res.status(404).json({ error: 'Eingang nicht vorhanden' });
    const bild = e._quelle.art === 't'
      ? await stapel.kachelBild(e._quelle)
      : await holeVorschau(vorschauSchluessel(e), () => ladePdf(e));
    res.set({
      'Content-Type': 'image/jpeg',
      'Content-Length': bild.length,
      'Cache-Control': 'private, no-store',
    });
    res.send(bild);
  } catch (err) {
    if (err instanceof VorschauUeberlastetError) {
      return res.status(503).set('Retry-After', '5').json({ error: err.message });
    }
    // Ein Vorschaufehler ist kein Störfall: die Kachel zeigt den Platzhalter.
    console.warn(`[eingang] Vorschau für ${req.params.schluessel} nicht erzeugt: ${err.message}`);
    res.status(404).json({ error: 'Keine Vorschau verfügbar' });
  }
});

// GET /api/eingang/:schluessel/pdf – das PDF des Eingangs
router.get('/:schluessel/pdf', async (req, res) => {
  try {
    const e = await findeEingang(req.params.schluessel);
    if (!e) return res.status(404).json({ error: 'Eingang nicht vorhanden' });
    const buffer = await ladePdf(e);
    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'inline; filename="eingang.pdf"',
      'Content-Length': buffer.length,
      'Cache-Control': 'no-store',
    });
    res.send(buffer);
  } catch (err) {
    if (err.status === 404) return res.status(404).json({ error: err.message });
    console.error('GET /api/eingang/:schluessel/pdf error:', err.message);
    res.status(502).json({ error: 'Das PDF ist gerade nicht erreichbar.' });
  }
});

// POST /api/eingang/:schluessel/neu-ausloesen – normale Verarbeitung erneut starten
router.post('/:schluessel/neu-ausloesen', async (req, res) => {
  try {
    res.json({ ok: true, ...(await loeseNeuAus(req.params.schluessel, benutzer(req))) });
  } catch (err) {
    fehlerAntwort(res, err, 'POST /api/eingang/neu-ausloesen');
  }
});

// POST /api/eingang/:schluessel/manuell-ablegen – Basisablage ohne KI
router.post('/:schluessel/manuell-ablegen', async (req, res) => {
  try {
    const { fehler, wert } = await pruefeManuelleErfassung(req.body);
    if (fehler) return res.status(400).json({ error: fehler });
    res.json({ ok: true, ...(await legeManuellAb(req.params.schluessel, wert, benutzer(req))) });
  } catch (err) {
    fehlerAntwort(res, err, 'POST /api/eingang/manuell-ablegen');
  }
});

// POST /api/eingang/:schluessel/verwerfen – PDF in den Papierkorb der Ablage
router.post('/:schluessel/verwerfen', async (req, res) => {
  try {
    res.json(await verwirf(req.params.schluessel, benutzer(req)));
  } catch (err) {
    fehlerAntwort(res, err, 'POST /api/eingang/verwerfen');
  }
});

export default router;

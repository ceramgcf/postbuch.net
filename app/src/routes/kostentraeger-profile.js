/**
 * Admin-only API für Kostenträger-Profile (Layout-Wissen für den generischen
 * EB-Parse-Prompt). Mounted mit requireAdmin in index.js.
 */
import { Router } from 'express';
import {
  listProfile, aktiviereProfil, deaktiviereProfil, loescheProfil, importiereProfil,
  listKatalog, aktiviereAusKatalog, uebernimmKatalogUpdate,
  ProfilAktivierungsFehler, ProfilValidierungsFehler,
} from '../service/kostentraeger-profil.js';
import {
  listProfilierbareAkten, profiliereAkte, ProfilierungsFehler,
} from '../service/kostentraeger-profilierung.js';

const router = Router();

function fehler(res, status, text, details = {}) {
  return res.status(status).json({ error: text, ...details });
}

function parseId(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    fehler(res, 400, 'Ungültige Profil-ID');
    return null;
  }
  return id;
}

router.get('/', async (req, res) => {
  try {
    res.json(await listProfile());
  } catch (err) {
    fehler(res, 500, 'Profile konnten nicht geladen werden.');
    console.error(err);
  }
});

router.get('/katalog', async (req, res) => {
  try {
    res.json(await listKatalog());
  } catch (err) {
    fehler(res, 500, 'Katalog konnte nicht geladen werden.');
    console.error(err);
  }
});

router.post('/katalog/:schluessel/aktivieren', async (req, res) => {
  const schluessel = typeof req.params.schluessel === 'string' ? req.params.schluessel : '';
  try {
    res.json(await aktiviereAusKatalog(schluessel));
  } catch (err) {
    if (err instanceof ProfilValidierungsFehler) return fehler(res, err.status, err.message);
    if (err instanceof ProfilAktivierungsFehler) {
      return fehler(res, err.status, err.message, { aktiveNamen: err.aktiveNamen });
    }
    fehler(res, 500, 'Katalog-Profil konnte nicht aktiviert werden.');
    console.error(err);
  }
});

router.post('/:id/update-anwenden', async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    res.json(await uebernimmKatalogUpdate(id));
  } catch (err) {
    if (err instanceof ProfilValidierungsFehler) return fehler(res, err.status, err.message);
    if (err.message === 'Profil nicht gefunden.') return fehler(res, 404, err.message);
    fehler(res, 500, 'Update konnte nicht übernommen werden.');
    console.error(err);
  }
});

router.get('/kandidaten-akten', async (req, res) => {
  try {
    res.json(await listProfilierbareAkten());
  } catch (err) {
    fehler(res, 500, 'Kandidaten-Akten konnten nicht geladen werden.');
    console.error(err);
  }
});

router.post('/profilieren', async (req, res) => {
  const akteid = typeof req.body?.akteid === 'string' ? req.body.akteid.trim() : '';
  if (!/^A[0-9]{6}$/.test(akteid)) {
    return fehler(res, 400, 'Ungültige Akte-ID');
  }
  try {
    res.json(await profiliereAkte(akteid, { username: req.session?.username }));
  } catch (err) {
    if (err instanceof ProfilierungsFehler) return fehler(res, err.status, err.message);
    if (err.message === 'Akte nicht gefunden oder leer.') return fehler(res, 404, err.message);
    fehler(res, 500, 'Profilierung fehlgeschlagen.');
    console.error(err);
  }
});

router.post('/import', async (req, res) => {
  try {
    res.json(await importiereProfil(req.body || {}));
  } catch (err) {
    if (err instanceof ProfilValidierungsFehler) return fehler(res, err.status, err.message);
    fehler(res, 500, 'Import fehlgeschlagen.');
    console.error(err);
  }
});

router.post('/:id/aktivieren', async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    res.json(await aktiviereProfil(id));
  } catch (err) {
    if (err instanceof ProfilAktivierungsFehler) {
      return fehler(res, err.status, err.message, { aktiveNamen: err.aktiveNamen });
    }
    if (err.message === 'Profil nicht gefunden.') return fehler(res, 404, err.message);
    fehler(res, 500, 'Profil konnte nicht aktiviert werden.');
    console.error(err);
  }
});

router.post('/:id/deaktivieren', async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    res.json(await deaktiviereProfil(id));
  } catch (err) {
    if (err.message === 'Profil nicht gefunden.') return fehler(res, 404, err.message);
    fehler(res, 500, 'Profil konnte nicht deaktiviert werden.');
    console.error(err);
  }
});

router.delete('/:id', async (req, res) => {
  const id = parseId(req, res);
  if (id === null) return;
  try {
    await loescheProfil(id);
    res.status(204).end();
  } catch (err) {
    if (err.message === 'Profil nicht gefunden.') return fehler(res, 404, err.message);
    fehler(res, 500, 'Profil konnte nicht gelöscht werden.');
    console.error(err);
  }
});

export default router;

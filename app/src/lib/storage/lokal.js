/**
 * lib/storage/lokal.js — Ablage in einem Ordner auf dem eigenen Rechner
 *
 * Der Ordner wird als Bind-Mount in den app-Container gereicht (Standard
 * `/ablage`, überschreibbar über POSTBUCH_LOKALE_ABLAGE). Unter Windows ist das
 * ein Windows-Ordner, den WSL über 9p/drvfs einbindet; unter Linux ein
 * beliebiges Verzeichnis. Der Nutzer sieht seine Dokumente dadurch direkt im
 * Explorer bzw. Dateimanager und kann den Ordner mit jedem Werkzeug sichern.
 *
 * ── IDs ─────────────────────────────────────────────────────────────────────
 * Ein Dateisystem hat keine stabilen IDs, die App speichert aber eine ID je
 * Dokument (storage_id) und erwartet, dass sie ein Verschieben überlebt. Die
 * Tabelle postbuch._ablage_lokal vergibt deshalb UUIDs und hält je Eintrag nur
 * Elternordner + Namen. Der Pfad ergibt sich aus der Kette bis zur Wurzel; ein
 * Verschieben eines Ordners ändert genau eine Zeile.
 *
 * Die Tabelle ist ein Spiegel, nicht die Wahrheit: jedes Auflisten gleicht den
 * Ordner mit ihr ab (neue Einträge bekommen eine ID, verschwundene werden als
 * verwaist markiert und kehren mit derselben ID zurück, wenn sie wieder
 * auftauchen). Dadurch funktioniert auch eine Datei, die der Nutzer selbst in
 * einen Ordner legt.
 *
 * ── Sicherheit ──────────────────────────────────────────────────────────────
 * • Jedes neue Segment läuft durch paths.js (sanitizeSegment/sanitizeFilename),
 *   wie bei Nextcloud. Windows-Gerätenamen (CON, NUL …) und Punkte am Ende
 *   werden dort bereits behandelt – auf einem Windows-Ordner sind sie echte
 *   Fallen, nicht nur Kosmetik.
 * • Jeder Zugriff prüft nach dem Auflösen der Symlinks (realpath), dass das
 *   Ziel unterhalb der Wurzel liegt. Symlinks im Ablageordner werden beim
 *   Auflisten ignoriert und nie verfolgt; auf einem Windows-Ordner lassen sie
 *   sich aus WSL heraus anlegen.
 * • Neue Dateien werden erst als temporäre Datei geschrieben und dann ohne
 *   Überschreiben an ihren Namen gebracht. Ein Absturz hinterlässt höchstens
 *   eine `.pbtmp-*`-Datei, nie ein halbes Dokument unter echtem Namen.
 * • Namenskollisionen entscheidet der eindeutige Index (parent_id, lower(name)),
 *   ohne Beachtung der Groß-/Kleinschreibung – Windows-Ordner kennen keine
 *   zwei Dateien „a.pdf“ und „A.pdf“.
 */

import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import path from 'node:path';
import db from '../../db.js';
import { loadDynamicSettings, getFolders } from '../../config.js';
import { sanitizeSegment, sanitizeFilename, splitSafePath } from './paths.js';

/** Backend-Name — identisch mit dem Wert in postbuch.storage_backend. */
export const name = 'lokal';

/** Anzeigename für UI und Logs. */
export const label = 'Lokaler Ordner';

/**
 * checksumInMeta bleibt FALSE: sha256 kennen wir nur für selbst geschriebene
 * Dateien. getMeta() liefert ihn pro Datei, solange die Datei seitdem nicht
 * verändert wurde.
 */
export const capabilities = {
  oauth: false,
  pfadAufloesung: true,
  checksumInMeta: false,
  freierSpeicher: true,
};

/** Wurzel im Container. */
export function wurzelPfad() {
  return path.resolve(process.env.POSTBUCH_LOKALE_ABLAGE || '/ablage');
}

/**
 * Wurde der Ablageordner ausdrücklich festgelegt (Installer oder Ordnerwahl
 * über den Host-Agenten)? Sonst zeigt der Mount auf den Ersatzordner im
 * Installationsverzeichnis, den eine Deinstallation mitlöschen würde – dort
 * legt postbuch.net nie Originale ab.
 */
export function istFestgelegt() {
  return process.env.POSTBUCH_LOKALE_ABLAGE_FESTGELEGT === '1' || !!process.env.POSTBUCH_LOKALE_ABLAGE;
}

/** Anzeigename der Wurzel auf dem Rechner des Nutzers (z. B. Windows-Pfad). */
export function wurzelAnzeige() {
  return String(process.env.POSTBUCH_LOKALE_ABLAGE_ANZEIGE || '').trim() || wurzelPfad();
}

/**
 * Vorprüfung eines neuen Ablageordners (Host-Auftrag `ablage`), damit die
 * Oberfläche Tippfehler sofort meldet. Maßgeblich bleibt die Prüfung des
 * Host-Agenten: Er kennt das Dateisystem und die erlaubten Orte.
 * Abgelehnt werden Zeichen, die Docker Compose in der .env deuten würde.
 *
 * @param {string} eingabe  Linux-Pfad oder Windows-Pfad (X:\…)
 * @returns {string|null}   Fehlermeldung oder null
 */
export function pruefeOrdnerEingabe(eingabe) {
  const p = typeof eingabe === 'string' ? eingabe : '';
  if (p.length < 2 || p.length > 400) return 'Bitte einen vollständigen Ordnerpfad angeben.';
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f$#"'`]/.test(p)) return 'Der Pfad enthält ein nicht erlaubtes Zeichen ($ # " \' ` oder Steuerzeichen).';
  let teile;
  if (/^[A-Za-z]:\\/.test(p)) {
    if (p.includes('/')) return 'Windows-Pfade bitte mit \\ trennen.';
    teile = p.slice(3).split('\\');
  } else if (p.startsWith('/')) {
    if (p.includes('\\')) return 'Der Pfad enthält ein nicht erlaubtes Zeichen (\\).';
    teile = p.slice(1).split('/');
  } else {
    return 'Bitte einen absoluten Pfad angeben, z. B. C:\\Users\\name\\Dokumente\\postbuch oder /home/name/postbuch.';
  }
  for (const t of teile) {
    if (!t) return 'Der Pfad enthält leere Teile (doppelte oder abschließende Trennzeichen).';
    if (t.startsWith('.')) return 'Ordnernamen dürfen nicht mit einem Punkt beginnen.';
    if (t !== t.trim()) return 'Ordnernamen dürfen nicht mit Leerzeichen beginnen oder enden.';
  }
  return null;
}

const TMP_PREFIX = '.pbtmp-';
const KOLLISION_MAX = 50;
const MAX_TIEFE = 64;
// So lange gilt ein frisch beanspruchter Eintrag ohne Datei als „im Entstehen“
// und wird beim Abgleich nicht als verwaist markiert.
const SCHONFRIST_SEKUNDEN = 120;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Fehler der lokalen Ablage, mit HTTP-artigem Status für die Ablaufsteuerung. */
export class LokalError extends Error {
  constructor(message, { status = 0 } = {}) {
    super(message);
    this.name = 'LokalError';
    this.status = status;
  }
}

// ── Hilfen ──────────────────────────────────────────────────────────────────

function mitZaehler(dateiname, n) {
  const m = dateiname.match(/^(.*?)(\.[A-Za-z0-9]{1,10})$/s);
  if (!m) return `${dateiname} (${n})`;
  return `${m[1]} (${n})${m[2]}`;
}

function kandidaten(wunschName) {
  const out = [];
  for (let n = 1; n <= KOLLISION_MAX; n++) out.push(n === 1 ? wunschName : mitZaehler(wunschName, n));
  return out;
}

function istEindeutigkeitsVerletzung(err) {
  return err?.code === '23505';
}

async function existiert(abs) {
  try {
    await fs.lstat(abs);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') return false;
    throw err;
  }
}

let _realeWurzel = null;
let _eigentuemer = null;   // { uid, gid } des Wurzelordners

/**
 * Die App läuft im Container als root. Was sie anlegt, gehört deshalb dem
 * Besitzer des Ablageordners, damit der Nutzer dort weiter selbst Dateien
 * ablegen und ändern kann. Ohne root-Rechte oder auf Dateisystemen ohne
 * Besitzer (Windows-Laufwerke unter WSL) bleibt es beim Ergebnis von mkdir/open.
 */
async function uebernimmEigentuemer(abs) {
  if (!_eigentuemer || process.getuid?.() !== 0) return;
  if (_eigentuemer.uid === 0 && _eigentuemer.gid === 0) return;
  await fs.chown(abs, _eigentuemer.uid, _eigentuemer.gid).catch(() => {});
}

/** Wurzel nach realpath; wirft verständlich, wenn der Ordner nicht eingebunden ist. */
async function realeWurzel() {
  const roh = wurzelPfad();
  if (!istFestgelegt()) {
    throw new LokalError(
      'Noch kein Ablageordner festgelegt. Wähle einen Ordner außerhalb des Installationsverzeichnisses.',
      { status: 503 },
    );
  }
  try {
    const st = await fs.stat(roh);
    if (!st.isDirectory()) throw new Error('kein Ordner');
    _realeWurzel = await fs.realpath(roh);
    _eigentuemer = { uid: st.uid, gid: st.gid };
    return _realeWurzel;
  } catch {
    throw new LokalError(
      `Der lokale Ablageordner ist nicht verfügbar (${wurzelAnzeige()}). Bitte prüfen, ob der Ordner existiert und eingebunden ist.`,
      { status: 503 },
    );
  }
}

/**
 * Prüft, dass abs (nach Auflösen aller Symlinks des vorhandenen Teils)
 * unterhalb der Wurzel liegt. Für noch nicht existierende Ziele wird der
 * Elternordner geprüft.
 */
async function assertInnerhalb(abs) {
  const wurzel = _realeWurzel || await realeWurzel();
  let pruef = abs;
  let real;
  for (;;) {
    try {
      real = await fs.realpath(pruef);
      break;
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
      const eltern = path.dirname(pruef);
      if (eltern === pruef) throw new LokalError('Pfadprüfung: Ziel nicht auflösbar.');
      pruef = eltern;
    }
  }
  if (real !== wurzel && !real.startsWith(`${wurzel}${path.sep}`)) {
    throw new LokalError('Pfadprüfung: Ziel liegt außerhalb des Ablageordners.');
  }
}

function pruefeSegment(seg) {
  if (typeof seg !== 'string' || !seg || seg === '.' || seg === '..' || seg.includes('/') || seg.includes('\0')) {
    throw new LokalError('Pfadprüfung: ungültiger Name in der Ablage.');
  }
  return seg;
}

export function isValidId(value) {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function looksLikeId(value) {
  return isValidId(String(value || '').trim().toLowerCase());
}

function assertId(id, context) {
  if (!isValidId(id)) throw new LokalError(`Ungültige Datei-ID (${context}).`, { status: 400 });
  return id;
}

// ── Tabelle ─────────────────────────────────────────────────────────────────

async function holeZeile(id, client = db) {
  const { rows: [z] } = await client.query(
    'SELECT * FROM postbuch._ablage_lokal WHERE id = $1 AND NOT verwaist',
    [id],
  );
  return z || null;
}

/** Wurzelzeile (parent_id NULL, name ''), legt sie bei Bedarf an. */
async function wurzelZeile() {
  await db.query(
    `INSERT INTO postbuch._ablage_lokal (parent_id, name, ist_ordner)
     VALUES (NULL, '', true)
     ON CONFLICT (parent_id, lower(name)) WHERE NOT verwaist DO NOTHING`,
  );
  const { rows: [z] } = await db.query(
    "SELECT * FROM postbuch._ablage_lokal WHERE parent_id IS NULL AND name = '' AND NOT verwaist",
  );
  return z;
}

/** Segmente von der Wurzel bis zum Eintrag (ohne Wurzel). */
async function segmenteVon(id) {
  const { rows } = await db.query(
    `WITH RECURSIVE kette AS (
       SELECT id, parent_id, name, verwaist, 0 AS tiefe
         FROM postbuch._ablage_lokal WHERE id = $1
       UNION ALL
       SELECT p.id, p.parent_id, p.name, p.verwaist, k.tiefe + 1
         FROM postbuch._ablage_lokal p JOIN kette k ON p.id = k.parent_id
        WHERE k.tiefe < $2
     )
     SELECT id, parent_id, name, verwaist, tiefe FROM kette ORDER BY tiefe DESC`,
    [id, MAX_TIEFE],
  );
  // Ein verwaister Ordner in der Kette heißt: der Pfad stimmt nicht mehr.
  if (!rows.length || rows.some((r) => r.verwaist)) {
    throw new LokalError('Die Datei ist in der lokalen Ablage nicht (mehr) vorhanden.', { status: 404 });
  }
  const oben = rows[0];
  if (oben.parent_id !== null || oben.name !== '') {
    throw new LokalError('Die Datei ist in der lokalen Ablage nicht (mehr) vorhanden.', { status: 404 });
  }
  return rows.slice(1).map((r) => pruefeSegment(r.name));
}

async function absVon(id) {
  const wurzel = await realeWurzel();
  const abs = path.join(wurzel, ...await segmenteVon(id));
  await assertInnerhalb(abs);
  return abs;
}

// ── Abgleich Ordner ↔ Tabelle ───────────────────────────────────────────────

/**
 * Gleicht einen Ordner mit der Tabelle ab und liefert seine Kinder.
 * @returns {Promise<Array<{id,name,ist_ordner,groesse,mtime}>>}
 */
async function gleicheAb(ordnerId) {
  const ordner = await holeZeile(ordnerId);
  if (!ordner) throw new LokalError('Der Ordner ist in der lokalen Ablage nicht (mehr) vorhanden.', { status: 404 });
  if (!ordner.ist_ordner) throw new LokalError('Der Eintrag ist kein Ordner.', { status: 400 });
  const abs = await absVon(ordnerId);

  let eintraege;
  try {
    eintraege = await fs.readdir(abs, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new LokalError('Der Ordner ist in der lokalen Ablage nicht (mehr) vorhanden.', { status: 404 });
    }
    throw err;
  }

  const aufPlatte = new Map();
  for (const e of eintraege) {
    if (e.isSymbolicLink()) continue;
    if (!e.isFile() && !e.isDirectory()) continue;
    if (e.name.startsWith(TMP_PREFIX)) {
      // Reste abgebrochener Schreibvorgänge nach einer Stunde aufräumen.
      try {
        const st = await fs.lstat(path.join(abs, e.name));
        if (Date.now() - st.mtimeMs > 3600_000) await fs.unlink(path.join(abs, e.name));
      } catch { /* egal */ }
      continue;
    }
    const schluessel = e.name.toLowerCase();
    if (aufPlatte.has(schluessel)) continue;   // nur auf case-sensitiven Dateisystemen möglich
    let st;
    try {
      st = await fs.lstat(path.join(abs, e.name));
    } catch {
      continue;
    }
    aufPlatte.set(schluessel, {
      name: e.name, ist_ordner: e.isDirectory(), groesse: e.isDirectory() ? null : st.size, mtime: st.mtime,
    });
  }

  const { rows: bekannt } = await db.query(
    'SELECT * FROM postbuch._ablage_lokal WHERE parent_id = $1 AND NOT verwaist',
    [ordnerId],
  );
  const inTabelle = new Map(bekannt.map((z) => [z.name.toLowerCase(), z]));

  // Verschwundene markieren (außer frisch beanspruchte Einträge im Entstehen).
  const fehlen = bekannt.filter((z) => !aufPlatte.has(z.name.toLowerCase())
    && Date.now() - new Date(z.updated_at).getTime() > SCHONFRIST_SEKUNDEN * 1000);
  if (fehlen.length) {
    await db.query(
      'UPDATE postbuch._ablage_lokal SET verwaist = true, updated_at = now() WHERE id = ANY($1::uuid[])',
      [fehlen.map((z) => z.id)],
    );
  }

  const kinder = [];
  for (const [schluessel, e] of aufPlatte) {
    let z = inTabelle.get(schluessel);
    if (z && (z.name !== e.name || z.ist_ordner !== e.ist_ordner)) {
      // Außerhalb umbenannt (nur Groß-/Kleinschreibung) oder Typ gewechselt.
      if (z.ist_ordner !== e.ist_ordner) {
        await db.query('UPDATE postbuch._ablage_lokal SET verwaist = true, updated_at = now() WHERE id = $1', [z.id]);
        z = null;
      } else {
        await db.query('UPDATE postbuch._ablage_lokal SET name = $2, updated_at = now() WHERE id = $1', [z.id, e.name]);
        z.name = e.name;
      }
    }
    if (!z) {
      // Wieder aufgetaucht? Dann mit alter ID zurückholen.
      const { rows: [alt] } = await db.query(
        `UPDATE postbuch._ablage_lokal SET verwaist = false, name = $3, groesse = $4, mtime = $5, updated_at = now()
          WHERE id = (SELECT id FROM postbuch._ablage_lokal
                       WHERE parent_id = $1 AND lower(name) = lower($3) AND ist_ordner = $2 AND verwaist
                       ORDER BY updated_at DESC LIMIT 1)
          RETURNING *`,
        [ordnerId, e.ist_ordner, e.name, e.groesse, e.mtime],
      ).catch((err) => {
        if (istEindeutigkeitsVerletzung(err)) return { rows: [] };
        throw err;
      });
      z = alt;
    }
    if (!z) {
      const { rows: [neu] } = await db.query(
        `INSERT INTO postbuch._ablage_lokal (parent_id, name, ist_ordner, groesse, mtime)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (parent_id, lower(name)) WHERE NOT verwaist DO NOTHING
         RETURNING *`,
        [ordnerId, e.name, e.ist_ordner, e.groesse, e.mtime],
      );
      z = neu || (await db.query(
        'SELECT * FROM postbuch._ablage_lokal WHERE parent_id = $1 AND lower(name) = lower($2) AND NOT verwaist',
        [ordnerId, e.name],
      )).rows[0];
    }
    if (!z) continue;
    if (!e.ist_ordner && (Number(z.groesse) !== e.groesse || new Date(z.mtime).getTime() !== e.mtime.getTime())) {
      // Datei wurde verändert: Größe/Zeit übernehmen, Prüfsumme gilt nicht mehr.
      const geaendert = z.mtime && new Date(z.mtime).getTime() !== e.mtime.getTime();
      await db.query(
        `UPDATE postbuch._ablage_lokal SET groesse = $2, mtime = $3,
                sha256 = CASE WHEN $4 THEN NULL ELSE sha256 END, updated_at = now()
          WHERE id = $1`,
        [z.id, e.groesse, e.mtime, !!geaendert],
      );
      if (geaendert) z.sha256 = null;
    }
    kinder.push({ id: z.id, name: e.name, ist_ordner: e.ist_ordner, groesse: e.groesse, mtime: e.mtime });
  }
  return kinder;
}

/**
 * Beansprucht einen Namen in einem Ordner (Tabelle zuerst, dann Platte) und
 * weicht bei Kollision auf „Name (2)“ aus.
 * @returns {Promise<{id:string, name:string, abs:string}>}
 */
async function beanspruche(elternId, wunschName, istOrdner, { nurExakt = false } = {}) {
  await gleicheAb(elternId);
  const elternAbs = await absVon(elternId);
  for (const kandidat of nurExakt ? [wunschName] : kandidaten(wunschName)) {
    pruefeSegment(kandidat);
    const { rows: [z] } = await db.query(
      `INSERT INTO postbuch._ablage_lokal (parent_id, name, ist_ordner)
       VALUES ($1, $2, $3)
       ON CONFLICT (parent_id, lower(name)) WHERE NOT verwaist DO NOTHING
       RETURNING id`,
      [elternId, kandidat, istOrdner],
    );
    if (!z) continue;
    const abs = path.join(elternAbs, kandidat);
    if (await existiert(abs)) {
      // Zwischen Abgleich und Anspruch auf der Platte entstanden.
      await db.query('DELETE FROM postbuch._ablage_lokal WHERE id = $1', [z.id]);
      continue;
    }
    await assertInnerhalb(abs);
    return { id: z.id, name: kandidat, abs };
  }
  if (nurExakt) return null;
  throw new LokalError(`Es existieren bereits ${KOLLISION_MAX} Einträge mit dem Namen "${wunschName}".`);
}

/** Schreibt Inhalt atomar über eine temporäre Datei im selben Ordner. */
async function schreibeTemp(ordnerAbs, content) {
  const tmp = path.join(ordnerAbs, `${TMP_PREFIX}${randomUUID()}`);
  const fh = await fs.open(tmp, 'wx', 0o644);
  await uebernimmEigentuemer(tmp);
  try {
    await fh.writeFile(content);
    await fh.sync();
  } finally {
    await fh.close();
  }
  return tmp;
}

/** Bringt tmp unter ziel, ohne eine vorhandene Datei zu überschreiben. */
async function ohneUeberschreiben(tmp, ziel) {
  try {
    await fs.link(tmp, ziel);
    await fs.unlink(tmp);
    return;
  } catch (err) {
    if (err.code === 'EEXIST') throw new LokalError('existiert', { status: 412 });
    if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV', 'EACCES', 'EINVAL'].includes(err.code)) throw err;
  }
  // Dateisystem ohne Hardlinks: Prüfen + rename. Die Lücke zwischen beiden ist
  // durch den Tabellenanspruch abgedeckt; nur ein fremder Prozess könnte sie treffen.
  if (await existiert(ziel)) throw new LokalError('existiert', { status: 412 });
  await fs.rename(tmp, ziel);
}

async function merkeDatei(id, abs, sha) {
  const st = await fs.stat(abs);
  await db.query(
    `UPDATE postbuch._ablage_lokal SET groesse = $2, mtime = $3, sha256 = $4, updated_at = now() WHERE id = $1`,
    [id, st.size, st.mtime, sha],
  );
  return st;
}

// ── Wiederfinden verschobener und umbenannter Einträge ─────────────────────
//
// Die ID eines Dokuments hängt nicht an seinem Pfad. Verschiebt oder benennt
// der Nutzer eine Datei außerhalb von postbuch.net um, findet der Gesamtabgleich
// sie über ihren Fingerabdruck (sha256) wieder und gibt ihr die alte ID zurück.
// Ordner werden über die Namen ihrer Inhalte wiedererkannt.
//
// Regeln:
// • Wiederbelebt werden nur abgehängte Einträge, auf die etwas zeigt (Dokument,
//   Fehlerliste, Pipeline, Ordnerkonfiguration). Ein gesunder Eintrag gibt seine
//   ID nie ab; eine bloße Kopie bekommt deshalb eine eigene ID.
// • Den Platz übernimmt nur ein Eintrag, auf den nichts zeigt.
// • Liegt dieselbe Datei mehrfach vor, ist es gleich, welche Kopie die alte ID
//   bekommt: Der Inhalt ist identisch.

// So lange gilt ein bei der letzten Suche nicht gefundener Eintrag als fehlend,
// ohne dass jeder weitere Zugriff die ganze Ablage erneut abgleicht.
const FEHLEND_GILT_MS = 5 * 60_000;
let _sucheLaeuft = null;
let _fehlend = { zeit: 0, ids: new Set() };

async function sha256Datei(abs) {
  const hash = createHash('sha256');
  const fh = await fs.open(abs, 'r');
  try {
    for await (const stueck of fh.createReadStream()) hash.update(stueck);
  } finally {
    await fh.close().catch(() => {});
  }
  return hash.digest('hex');
}

/** IDs, auf die außerhalb der Tabelle etwas zeigt. */
async function referenzierteIds() {
  const { rows } = await db.query(
    `SELECT storage_id AS id FROM postbuch.postbuch WHERE storage_backend = $1 AND storage_id IS NOT NULL
     UNION SELECT storage_id FROM postbuch._failed_documents WHERE storage_backend = $1 AND storage_id IS NOT NULL
     UNION SELECT storage_id FROM postbuch._pipeline_suspensions WHERE storage_backend = $1 AND storage_id IS NOT NULL
     UNION SELECT storage_id FROM postbuch._pipeline_file_journal WHERE storage_backend = $1
     UNION SELECT source_storage_id FROM postbuch._pipeline_file_journal
            WHERE storage_backend = $1 AND source_storage_id IS NOT NULL
     UNION SELECT eingang->>'onedriveFileId' FROM postbuch._pipeline_auftrag
            WHERE eingang->>'storageBackend' = $1 AND eingang->>'onedriveFileId' IS NOT NULL`,
    [name],
  );
  const ids = new Set(rows.map((r) => r.id));
  const settings = await loadDynamicSettings();
  for (const id of Object.values(getFolders(settings, name))) if (id) ids.add(String(id));
  return ids;
}

/**
 * Alle Einträge mit dem Kennzeichen, ob sie von der Wurzel aus über nicht
 * verwaiste Ordner erreichbar sind.
 */
async function eintraegeMitErreichbarkeit() {
  const { rows } = await db.query(
    `WITH RECURSIVE erreichbar AS (
       SELECT id, 0 AS tiefe FROM postbuch._ablage_lokal
        WHERE parent_id IS NULL AND name = '' AND NOT verwaist
       UNION ALL
       SELECT c.id, e.tiefe + 1 FROM postbuch._ablage_lokal c
         JOIN erreichbar e ON c.parent_id = e.id
        WHERE NOT c.verwaist AND e.tiefe < $1
     )
     SELECT a.*, (er.id IS NOT NULL) AS erreichbar
       FROM postbuch._ablage_lokal a LEFT JOIN erreichbar er ON er.id = a.id
      WHERE a.parent_id IS NOT NULL`,
    [MAX_TIEFE],
  );
  return rows;
}

/** Übergibt Platz und Namen von neu an alt; neu (samt Unterbaum) verschwindet. */
async function uebernehmePlatz(altId, neu, felder = {}) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM postbuch._ablage_lokal WHERE id = $1', [neu.id]);
    await client.query(
      `UPDATE postbuch._ablage_lokal
          SET parent_id = $2, name = $3, verwaist = false, updated_at = now(),
              groesse = COALESCE($4, groesse), mtime = COALESCE($5, mtime), sha256 = COALESCE($6, sha256)
        WHERE id = $1`,
      [altId, neu.parent_id, neu.name, felder.groesse ?? null, felder.mtime ?? null, felder.sha256 ?? null],
    );
    await client.query('COMMIT');
    return true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (istEindeutigkeitsVerletzung(err)) return false;
    throw err;
  } finally {
    client.release();
  }
}

/** Ordner: abgehängter Ordner mit Bezug ↔ neuer Ordner mit denselben Inhaltsnamen. */
async function ordnerZuordnen(refs) {
  let gesamt = 0;
  for (let runde = 0; runde < MAX_TIEFE; runde++) {
    const alle = await eintraegeMitErreichbarkeit();
    const kinder = new Map();
    for (const z of alle) {
      if (!kinder.has(z.parent_id)) kinder.set(z.parent_id, []);
      kinder.get(z.parent_id).push(z);
    }
    const unterbaum = (id) => {
      const out = [];
      const stapel = [id];
      while (stapel.length) {
        const k = kinder.get(stapel.pop()) || [];
        for (const c of k) { out.push(c); stapel.push(c.id); }
      }
      return out;
    };
    const hatBezug = (z) => refs.has(z.id) || unterbaum(z.id).some((c) => refs.has(c.id));
    const namen = (id) => (kinder.get(id) || []).filter((c) => !c.verwaist)
      .map((c) => `${c.ist_ordner ? 'd' : 'f'}:${c.name.toLowerCase()}`).sort().join('\n');

    // Nur die oberste abgehängte Ebene: Darunterliegendes kommt mit ihr zurück.
    const byId = new Map(alle.map((z) => [z.id, z]));
    const alteOrdner = alle.filter((z) => z.ist_ordner && !z.erreichbar
      && (z.verwaist || byId.get(z.parent_id)?.erreichbar) && hatBezug(z));
    const neueOrdner = alle.filter((z) => z.ist_ordner && z.erreichbar && !hatBezug(z));
    const nachNamen = new Map();
    for (const n of neueOrdner) {
      const s = namen(n.id);
      if (!s) continue;
      if (!nachNamen.has(s)) nachNamen.set(s, []);
      nachNamen.get(s).push(n);
    }
    let diesmal = 0;
    for (const alt of alteOrdner) {
      const s = namen(alt.id);
      const treffer = s && nachNamen.get(s);
      if (!treffer || treffer.length !== 1) continue;   // mehrdeutig: lieber nichts tun
      const neu = treffer[0];
      if (await uebernehmePlatz(alt.id, neu)) {
        nachNamen.delete(s);
        diesmal++;
      }
    }
    gesamt += diesmal;
    if (!diesmal) break;
  }
  return gesamt;
}

/** Dateien: abgehängte Datei mit Bezug ↔ neue Datei mit demselben Fingerabdruck. */
async function dateienZuordnen(refs) {
  const alle = await eintraegeMitErreichbarkeit();
  const alteDateien = alle.filter((z) => !z.ist_ordner && !z.erreichbar && refs.has(z.id));
  if (!alteDateien.length) return 0;

  const { rows: doks } = await db.query(
    `SELECT storage_id, sha256 FROM postbuch.postbuch
      WHERE storage_backend = $1 AND storage_id = ANY($2::text[]) AND sha256 IS NOT NULL`,
    [name, alteDateien.map((z) => z.id)],
  );
  const dokHash = new Map(doks.map((d) => [d.storage_id, d.sha256]));
  const gesucht = new Map();   // hash → [alt]
  for (const alt of alteDateien) {
    const h = alt.sha256 || dokHash.get(alt.id);
    if (!h) continue;
    if (!gesucht.has(h)) gesucht.set(h, []);
    gesucht.get(h).push(alt);
  }
  if (!gesucht.size) return 0;
  const groessen = new Set(alteDateien.map((z) => (z.groesse == null ? null : Number(z.groesse))));
  const jetzt = Date.now();
  const neueDateien = alle.filter((z) => !z.ist_ordner && z.erreichbar && !refs.has(z.id)
    // Gerade von postbuch.net selbst geschrieben: gehört zu einem laufenden Vorgang.
    && !(z.sha256 && jetzt - new Date(z.created_at).getTime() < SCHONFRIST_SEKUNDEN * 1000)
    && (groessen.has(null) || groessen.has(Number(z.groesse))));

  let gesamt = 0;
  for (const neu of neueDateien) {
    if (!gesucht.size) break;
    let h;
    let st;
    try {
      const abs = await absVon(neu.id);
      st = await fs.lstat(abs);
      if (!st.isFile()) continue;
      const unveraendert = neu.mtime && new Date(neu.mtime).getTime() === st.mtime.getTime();
      h = (unveraendert && neu.sha256) || await sha256Datei(abs);
    } catch {
      continue;
    }
    if (h !== neu.sha256) {
      await db.query('UPDATE postbuch._ablage_lokal SET sha256 = $2, groesse = $3, mtime = $4 WHERE id = $1',
        [neu.id, h, st.size, st.mtime]);
    }
    const liste = gesucht.get(h);
    if (!liste?.length) continue;
    const alt = liste.shift();
    if (!liste.length) gesucht.delete(h);
    if (await uebernehmePlatz(alt.id, neu, { groesse: st.size, mtime: st.mtime, sha256: h })) gesamt++;
  }
  return gesamt;
}

async function sucheVerschobeneIntern() {
  const wurzel = await getRoot();
  const queue = [wurzel.id];
  const gesehen = new Set();
  while (queue.length) {
    const id = queue.shift();
    if (gesehen.has(id)) continue;
    gesehen.add(id);
    let kinder;
    try {
      kinder = await gleicheAb(id);
    } catch (err) {
      if (err instanceof LokalError && err.status === 404) continue;
      throw err;
    }
    for (const k of kinder) if (k.ist_ordner) queue.push(k.id);
  }
  const refs = await referenzierteIds();
  const ordner = await ordnerZuordnen(refs);
  const dateien = await dateienZuordnen(refs);
  if (ordner || dateien) {
    console.log(`[lokal] Wiedergefunden: ${ordner} Ordner, ${dateien} Datei(en) an neuem Ort oder unter neuem Namen`);
  }
  const fehlend = (await eintraegeMitErreichbarkeit()).filter((z) => !z.erreichbar).map((z) => z.id);
  _fehlend = { zeit: Date.now(), ids: new Set(fehlend) };
  return { ordner, dateien, fehlend: fehlend.length };
}

/**
 * Gleicht die ganze Ablage ab und ordnet verschobene oder umbenannte Einträge
 * ihrer alten ID zu. Läuft nie doppelt: Ein zweiter Aufruf wartet auf den
 * laufenden.
 * @returns {Promise<{ordner:number, dateien:number, fehlend:number}>}
 */
export async function sucheVerschobene() {
  if (!_sucheLaeuft) {
    _sucheLaeuft = sucheVerschobeneIntern().finally(() => { _sucheLaeuft = null; });
  }
  return _sucheLaeuft;
}

/**
 * Führt fn aus; meldet sie „nicht (mehr) vorhanden“, wird erst die Ablage
 * nach dem Eintrag durchsucht und dann ein zweites Mal versucht. Ein 404
 * verlässt den Adapter damit nur, wenn die Datei wirklich fehlt – die
 * Aufrufer lösen daraufhin die Verknüpfung (storage-missing.js). Was die
 * letzte Suche schon nicht fand, löst für ein paar Minuten keine neue aus.
 */
async function mitSuche(id, fn) {
  try {
    return await fn();
  } catch (err) {
    if (!(err instanceof LokalError) || err.status !== 404) throw err;
    if (Date.now() - _fehlend.zeit < FEHLEND_GILT_MS && _fehlend.ids.has(id)) throw err;
    try {
      await sucheVerschobene();
    } catch {
      throw err;
    }
    return fn();
  }
}

// ── Interface: Lesen ────────────────────────────────────────────────────────

export async function getRoot() {
  await realeWurzel();
  const z = await wurzelZeile();
  return { id: z.id, name: path.basename(wurzelAnzeige().replace(/[\\/]+$/, '')) || 'Ablage' };
}

/** Der Ablageordner gehört ganz postbuch.net – Wurzel und Ablagebereich fallen zusammen. */
export async function getAblageRoot() {
  return getRoot();
}

/** Die Struktur darf direkt im Ablageordner liegen (wie bei OneDrive). */
export async function wurzelDirektErlaubt() {
  return true;
}

export async function getMeta(id) {
  assertId(id, 'getMeta');
  return mitSuche(id, () => getMetaDirekt(id));
}

async function getMetaDirekt(id) {
  const z = await holeZeile(id);
  if (!z) throw new LokalError('Die Datei ist in der lokalen Ablage nicht (mehr) vorhanden.', { status: 404 });
  const abs = await absVon(id);
  let st;
  try {
    st = await fs.lstat(abs);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new LokalError('Die Datei ist in der lokalen Ablage nicht (mehr) vorhanden.', { status: 404 });
    }
    throw err;
  }
  if (st.isSymbolicLink()) throw new LokalError('Symbolische Verknüpfungen werden nicht unterstützt.', { status: 400 });
  const unveraendert = z.mtime && new Date(z.mtime).getTime() === st.mtime.getTime();
  return {
    id: z.id,
    name: z.name,
    parentId: z.parent_id,
    lastModified: st.mtime.toISOString(),
    webUrl: null,
    size: st.isDirectory() ? 0 : st.size,
    isFolder: st.isDirectory(),
    sha256: (!st.isDirectory() && unveraendert && z.sha256) || undefined,
  };
}

export async function getPath(id) {
  assertId(id, 'getPath');
  return mitSuche(id, async () => `/${(await segmenteVon(id)).join('/')}`);
}

export async function resolvePath(p) {
  const segmente = splitSafePath(p);
  let aktuell = (await getRoot()).id;
  let letzterName = '';
  for (const seg of segmente) {
    const kinder = await gleicheAb(aktuell);
    const treffer = kinder.find((k) => k.name.toLowerCase() === seg.toLowerCase());
    if (!treffer) throw new LokalError(`Der Ordner "${p}" existiert in der lokalen Ablage nicht.`, { status: 404 });
    aktuell = treffer.id;
    letzterName = treffer.name;
  }
  return { id: aktuell, name: letzterName };
}

export async function listChildren(folderId) {
  assertId(folderId, 'listChildren');
  const kinder = await gleicheAb(folderId);
  return kinder.map((k) => ({
    id: k.id,
    name: k.name,
    size: k.ist_ordner ? 0 : k.groesse,
    createdAt: k.mtime.toISOString(),
    createdDateTime: k.mtime.toISOString(),
    isFolder: k.ist_ordner,
  }));
}

export async function listAllFiles(folderId) {
  const kinder = await listChildren(folderId);
  return kinder.filter((k) => !k.isFolder).map((k) => ({ id: k.id, name: k.name }));
}

export async function listAllFilesRecursive(rootFolderId) {
  assertId(rootFolderId, 'listAllFilesRecursive');
  const dateien = [];
  const queue = [rootFolderId];
  const gesehen = new Set();
  while (queue.length) {
    const ordnerId = queue.shift();
    if (gesehen.has(ordnerId)) continue;
    gesehen.add(ordnerId);
    for (const k of await gleicheAb(ordnerId)) {
      if (k.ist_ordner) {
        queue.push(k.id);
      } else {
        dateien.push({
          id: k.id,
          name: k.name,
          parentId: ordnerId,
          size: k.groesse,
          webUrl: null,
          lastModifiedDateTime: k.mtime.toISOString(),
        });
      }
    }
  }
  return dateien;
}

export async function download(id, onProgress) {
  assertId(id, 'download');
  return mitSuche(id, () => downloadDirekt(id, onProgress));
}

async function downloadDirekt(id, onProgress) {
  const abs = await absVon(id);
  let buf;
  try {
    const st = await fs.lstat(abs);
    if (!st.isFile()) throw new LokalError('Der Eintrag ist keine Datei.', { status: 400 });
    buf = await fs.readFile(abs);
  } catch (err) {
    if (err.code === 'ENOENT') {
      throw new LokalError('Die Datei ist in der lokalen Ablage nicht (mehr) vorhanden.', { status: 404 });
    }
    throw err;
  }
  onProgress?.({ receivedBytes: buf.length, totalBytes: buf.length });
  return buf;
}

// ── Interface: Ordner ───────────────────────────────────────────────────────

export async function createFolder(parentFolderId, folderName) {
  assertId(parentFolderId, 'createFolder');
  const sicher = sanitizeSegment(folderName);
  if (!sicher) throw new LokalError(`"${String(folderName).slice(0, 40)}" ergibt keinen gültigen Ordnernamen.`);
  for (let versuch = 0; versuch < 3; versuch++) {
    const r = await beanspruche(parentFolderId, sicher, true);
    try {
      await fs.mkdir(r.abs);
      await uebernimmEigentuemer(r.abs);
      await merkeDatei(r.id, r.abs, null);
      return { id: r.id };
    } catch (err) {
      await db.query('DELETE FROM postbuch._ablage_lokal WHERE id = $1', [r.id]);
      if (err.code !== 'EEXIST') throw err;
    }
  }
  throw new LokalError(`Der Ordner "${sicher}" ließ sich nicht anlegen.`);
}

/**
 * Sucht einen Unterordner (ohne Beachtung der Groß-/Kleinschreibung); legt ihn
 * an, wenn er fehlt. Ein vorhandener Ordner wird nie verändert. `strict` ist
 * hier immer erfüllt: der Name wird exakt beansprucht, ein „Name (2)“ entsteht
 * nie.
 */
export async function findOrCreateFolder(parentFolderId, folderName, _opts = {}) {
  assertId(parentFolderId, 'findOrCreateFolder');
  const sicher = sanitizeSegment(folderName);
  if (!sicher) throw new LokalError(`"${String(folderName).slice(0, 40)}" ergibt keinen gültigen Ordnernamen.`);

  const finde = async () => {
    const kinder = await gleicheAb(parentFolderId);
    return kinder.find((k) => k.name.toLowerCase() === sicher.toLowerCase()) || null;
  };

  const vorhanden = await finde();
  if (vorhanden) {
    if (!vorhanden.ist_ordner) throw new LokalError(`"${sicher}" existiert bereits als Datei.`);
    return { id: vorhanden.id, existed: true };
  }
  const r = await beanspruche(parentFolderId, sicher, true, { nurExakt: true });
  if (!r) {
    const da = await finde();
    if (da?.ist_ordner) return { id: da.id, existed: true };
    throw new LokalError(`Der Ordner "${sicher}" ließ sich nicht anlegen.`);
  }
  try {
    await fs.mkdir(r.abs);
    await uebernimmEigentuemer(r.abs);
  } catch (err) {
    await db.query('DELETE FROM postbuch._ablage_lokal WHERE id = $1', [r.id]);
    if (err.code === 'EEXIST') {
      const da = await finde();
      if (da?.ist_ordner) return { id: da.id, existed: true };
    }
    throw err;
  }
  await merkeDatei(r.id, r.abs, null);
  return { id: r.id, existed: false };
}

// ── Interface: Schreiben ────────────────────────────────────────────────────

export async function uploadNew(content, fileName, parentFolderId) {
  assertId(parentFolderId, 'uploadNew');
  const sicher = sanitizeFilename(fileName, 'Dokument');
  const sha = createHash('sha256').update(content).digest('hex');
  const elternAbs = await absVon(parentFolderId);
  const tmp = await schreibeTemp(elternAbs, content);
  try {
    for (let versuch = 0; versuch < 3; versuch++) {
      const r = await beanspruche(parentFolderId, sicher, false);
      try {
        await ohneUeberschreiben(tmp, r.abs);
      } catch (err) {
        await db.query('DELETE FROM postbuch._ablage_lokal WHERE id = $1', [r.id]);
        if (err instanceof LokalError && err.status === 412) continue;
        throw err;
      }
      await merkeDatei(r.id, r.abs, sha);
      return { id: r.id, webUrl: null, name: r.name };
    }
    throw new LokalError(`Die Datei "${sicher}" ließ sich nicht ablegen.`);
  } finally {
    await fs.unlink(tmp).catch(() => {});
  }
}

export async function uploadContent(id, content) {
  assertId(id, 'uploadContent');
  return mitSuche(id, () => uploadContentDirekt(id, content));
}

async function uploadContentDirekt(id, content) {
  const abs = await absVon(id);
  const sha = createHash('sha256').update(content).digest('hex');
  const tmp = await schreibeTemp(path.dirname(abs), content);
  try {
    await fs.rename(tmp, abs);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
  await merkeDatei(id, abs, sha);
}

/** Ist kandidatId gleich id oder ein Nachfahre von id? */
async function istNachfahre(kandidatId, id) {
  const { rows: [r] } = await db.query(
    `WITH RECURSIVE kette AS (
       SELECT id, parent_id, 0 AS tiefe FROM postbuch._ablage_lokal WHERE id = $1
       UNION ALL
       SELECT p.id, p.parent_id, k.tiefe + 1 FROM postbuch._ablage_lokal p
         JOIN kette k ON p.id = k.parent_id WHERE k.tiefe < $3
     ) SELECT EXISTS (SELECT 1 FROM kette WHERE id = $2) AS treffer`,
    [kandidatId, id, MAX_TIEFE],
  );
  return !!r?.treffer;
}

export async function move(id, destFolderId, newName) {
  assertId(id, 'move');
  assertId(destFolderId, 'move');
  return mitSuche(id, () => moveDirekt(id, destFolderId, newName));
}

async function moveDirekt(id, destFolderId, newName) {
  const z = await holeZeile(id);
  if (!z) throw new LokalError('Die Datei ist in der lokalen Ablage nicht (mehr) vorhanden.', { status: 404 });
  const sicher = z.ist_ordner
    ? (sanitizeSegment(newName) || sanitizeFilename(newName, 'Ordner'))
    : sanitizeFilename(newName, 'Dokument');
  const quellAbs = await absVon(id);
  if (z.ist_ordner && await istNachfahre(destFolderId, id)) {
    throw new LokalError('Ein Ordner kann nicht in sich selbst verschoben werden.', { status: 400 });
  }

  // Ziel = aktueller Ort: kein Vorgang (wie bei OneDrive/Nextcloud).
  if (z.parent_id === destFolderId && z.name === sicher) {
    return { id, webUrl: null, name: sicher };
  }
  // Nur Groß-/Kleinschreibung ändert sich im selben Ordner.
  if (z.parent_id === destFolderId && z.name.toLowerCase() === sicher.toLowerCase()) {
    const ziel = path.join(path.dirname(quellAbs), sicher);
    await fs.rename(quellAbs, ziel);
    await db.query('UPDATE postbuch._ablage_lokal SET name = $2, updated_at = now() WHERE id = $1', [id, sicher]);
    return { id, webUrl: null, name: sicher };
  }

  await gleicheAb(destFolderId);
  const zielElternAbs = await absVon(destFolderId);
  for (const kandidat of kandidaten(sicher)) {
    const zielAbs = path.join(zielElternAbs, kandidat);
    if (await existiert(zielAbs)) continue;
    await assertInnerhalb(zielAbs);
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      try {
        await client.query(
          'UPDATE postbuch._ablage_lokal SET parent_id = $2, name = $3, updated_at = now() WHERE id = $1',
          [id, destFolderId, kandidat],
        );
      } catch (err) {
        await client.query('ROLLBACK');
        if (istEindeutigkeitsVerletzung(err)) continue;
        throw err;
      }
      if (await existiert(zielAbs)) {
        await client.query('ROLLBACK');
        continue;
      }
      try {
        await fs.rename(quellAbs, zielAbs);
      } catch (err) {
        await client.query('ROLLBACK');
        if (err.code === 'ENOENT' && !await existiert(quellAbs)) {
          throw new LokalError('Die Datei ist in der lokalen Ablage nicht (mehr) vorhanden.', { status: 404 });
        }
        throw err;
      }
      await client.query('COMMIT');
      return { id, webUrl: null, name: kandidat };
    } finally {
      client.release();
    }
  }
  throw new LokalError(`Es existieren bereits ${KOLLISION_MAX} Einträge mit dem Namen "${sicher}".`);
}

export async function moveToTrash(id, trashName) {
  const settings = await loadDynamicSettings();
  const trashFolderId = getFolders(settings, name).trash;
  if (!trashFolderId) {
    throw new LokalError('Lokale Ablage: Papierkorb-Ordner nicht konfiguriert (storage_folders.lokal.trash fehlt).');
  }
  return move(id, trashFolderId, trashName);
}

/** Löscht eine Datei oder einen leeren Ordner endgültig. */
export async function remove(id) {
  assertId(id, 'remove');
  const z = await holeZeile(id);
  if (!z) return;
  if (z.parent_id === null) throw new LokalError('Die Wurzel der Ablage kann nicht gelöscht werden.', { status: 400 });
  const abs = await absVon(id);
  try {
    const st = await fs.lstat(abs);
    if (st.isDirectory()) await fs.rmdir(abs);
    else await fs.unlink(abs);
  } catch (err) {
    if (err.code === 'ENOTEMPTY' || err.code === 'EEXIST') {
      throw new LokalError('Der Ordner ist nicht leer.', { status: 409 });
    }
    if (err.code !== 'ENOENT') throw err;
  }
  await db.query('DELETE FROM postbuch._ablage_lokal WHERE id = $1', [id]);
}

// ── Speicherplatz und Verbindungstest ───────────────────────────────────────

export async function getFreeSpace() {
  const wurzel = await realeWurzel();
  const st = await fs.statfs(wurzel);
  return { freiBytes: Number(st.bavail) * Number(st.bsize), gesamtBytes: Number(st.blocks) * Number(st.bsize) };
}

/**
 * Prüft, ob der Ordner eingebunden und beschreibbar ist (schreibt und löscht
 * eine temporäre Datei, sonst nichts).
 */
export async function testeVerbindung() {
  const wurzel = await realeWurzel();
  await fs.access(wurzel, FS.R_OK | FS.W_OK);
  const tmp = await schreibeTemp(wurzel, Buffer.from('postbuch.net'));
  await fs.unlink(tmp);
  const platz = await getFreeSpace();
  return { ok: true, pfad: wurzelAnzeige(), ...platz };
}

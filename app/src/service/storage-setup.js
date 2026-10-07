/**
 * service/storage-setup.js — Ordnerstruktur-Assistent (backend-agnostisch)
 *
 * Erstellt die komplette postbuch-Ordnerstruktur im aktiven Ablage-Backend und
 * speichert alle Ordner-IDs in _settings.storage_folders[<backend>].
 *
 * Die Systemordner-Definition ist für alle Backends dieselbe; das
 * Anlegen läuft ausschließlich über adapter.findOrCreateFolder(…, {strict:true}).
 *
 * Sicherheitsregel: Bereits vorhandene Ordner werden NIEMALS überschrieben
 * oder gelöscht. Es wird nur die ID aus dem vorhandenen Ordner gelesen.
 */

import db from '../db.js';
import { loadDynamicSettings, getActiveBackendName, getFolders, getAblageEbenen, getAblagePersonQuelle, ABLAGE_EBENEN } from '../config.js';
import { getAdapter } from '../lib/storage/index.js';
import { getAktiveTaxonomie, getGesamteTaxonomie } from '../lib/taxonomie.js';
import { appLog } from '../app-log.js';

/**
 * Systemordner-Definition. L-Ordner stammen aus der Taxonomie, D-Ordner werden
 * bei der ersten Belegung einer L×D-Zelle automatisch angelegt.
 * Bei System-Ordnern können mehrere Keys denselben physischen Ordner
 * referenzieren (z. B. inbox + directscan).
 * folder: Name des Ordners, der unter rootPath erstellt wird.
 * Es ist erlaubt, verschiedenen Einträgen dieselbe folder-ID manuell zuzuweisen,
 * aber der Assistent legt pro folder-Eintrag einen eigenen Ordner an.
 */
export const SYSTEM_FOLDERS = [
  // ── System-Ordner (mehrere Keys → gleicher physischer Ordner) ─────────────
  { folder: '_inbox',             keys: ['inbox', 'directscan'], description: 'Eingangsordner für neue Scans' },
  { folder: '_failed',            keys: ['failed'],            description: 'Fehlgeschlagene Verarbeitungen' },
  { folder: '_suspended',         keys: ['suspended'],         description: 'Pausierte Dokumente mit offenem Duplikat-Verdacht' },
  { folder: '_trash',             keys: ['trash'],             description: 'Papierkorb / Duplikate' },
  { folder: '_backup',            keys: ['backup'],            description: 'Datenbankbackups' },
  { folder: '_abrechnung_merged', keys: ['abrechnungMerged', 'abrechnung'], description: 'Zusammengeführte Abrechnungs-PDFs' },
  { folder: '_debug',             keys: ['debug'],                          description: 'KI-Pipeline-Debuglogs (nur bei aktiviertem Debug-Modus)' },
];

/**
 * Hauptfunktion: Erstellt alle Ordner unter rootFolderPath im angegebenen
 * Backend und speichert die IDs in _settings.storage_folders[<backend>].
 *
 * @param {string} rootFolderPath  Pfad des Root-Ordners (z. B. "/postbuch" oder "postbuch")
 * @param {string} [backendName]   Backend; Default: das aktive
 * @param {(fortschritt:{schritt:number,gesamt:number,name:string})=>void} [onProgress]
 * @returns {Array<{ folder, id, existed, keys }>}  Status für jeden Ordner
 */
export async function setupFolderStructure(rootFolderPath, backendName, onProgress) {
  const settings = await loadDynamicSettings();
  const backend = backendName || getActiveBackendName(settings);
  const adapter = getAdapter(backend);

  // 1) Root-Ordner auflösen (erstellen oder vorhandenen nehmen).
  // Der Pfad kann mehrstufig sein (z. B. "archiv/postbuch") → segmentweise.
  const cleanRoot = rootFolderPath.replace(/^\/+/, '').replace(/\/+$/, '') || 'postbuch';
  const segments = cleanRoot.split('/').filter(Boolean);

  // Lebensbereichsordner gehören nur an die Wurzel, wenn sie dort die erste
  // Ebene bilden. Sonst werden sie unter ihrer Vorebene lazy angelegt; an der
  // Wurzel stünden sie nur leer herum.
  const lebensbereichZuerst = getAblageEbenen(settings)[0] === 'lebensbereich';
  const taxonomie = await getAktiveTaxonomie();
  const lebensbereiche = lebensbereichZuerst ? taxonomie.lebensbereiche : [];
  const gesamt = segments.length + SYSTEM_FOLDERS.length + lebensbereiche.length;
  let schritt = 0;
  const melde = (name) => onProgress?.({ schritt: ++schritt, gesamt, name });

  const root = await adapter.getRoot();
  let currentParentId = root.id;
  for (const seg of segments) {
    const { id } = await adapter.findOrCreateFolder(currentParentId, seg, { strict: true });
    currentParentId = id;
    melde(seg);
  }
  const rootFolderId = currentParentId;

  // 2) Stabile System- und Lebensbereichsordner erstellen. Bestehende flache
  // Dokumenttyp-Keys bleiben in storage_folders unangetastet und dienen bis
  // zur Reorganisation weiterhin dem Legacy-Pfad.
  const results = [];
  for (const def of SYSTEM_FOLDERS) {
    const { id, existed } = await adapter.findOrCreateFolder(rootFolderId, def.folder, { strict: true });
    results.push({ folder: def.folder, id, existed, keys: def.keys });
    melde(def.folder);
  }
  for (const lebensbereich of lebensbereiche) {
    const { id, existed } = await adapter.findOrCreateFolder(rootFolderId, lebensbereich.label, { strict: true });
    results.push({ folder: lebensbereich.label, id, existed, keys: [lebensbereich.code] });
    melde(lebensbereich.label);
  }

  // 3) IDs in _settings speichern — nur der Teilbaum des eigenen Backends,
  //    bereits konfigurierte Keys bleiben erhalten.
  const patch = {};
  for (const r of results) {
    for (const key of r.keys) {
      patch[key] = r.id;
    }
  }
  await saveFolderIds(backend, patch, settings);

  // 4) Pfadgrenze des Backends nachziehen. Backends mit Pfad-Ortsmodell
  //    (Nextcloud) grenzen ID-aufgelöste Zugriffe zusätzlich auf den
  //    Postbuch-Wurzelordner ein. Diese Grenze ist kein zweiter, frei
  //    einstellbarer Wert, sondern genau der Ordner, in dem die Struktur
  //    gerade angelegt wurde — sonst laufen beide auseinander und jede
  //    Pfadprüfung schlägt fehl.
  if (typeof adapter.merkeAblageWurzelPfad === 'function') {
    await adapter.merkeAblageWurzelPfad(cleanRoot);
  }

  return results;
}

/**
 * Gleicht die gespeicherte Pfadgrenze mit dem tatsächlichen Wurzelordner ab
 * und korrigiert sie, wenn sie auseinanderlaufen.
 *
 * Nötig für Instanzen, auf denen die Grenze aus einer früheren Version stammt,
 * in der sie getrennt von der Ordneranlage gepflegt wurde. Wahrheit ist immer
 * der Ordner, in dem die Struktur wirklich liegt (ermittleWurzelPfad); die
 * gespeicherte Grenze ist nur dessen Zwischenspeicher.
 *
 * Ist das Backend gerade nicht erreichbar oder noch nichts eingerichtet,
 * passiert nichts — dann liefert ermittleWurzelPfad() null und ein Raten wäre
 * schlimmer als Nichtstun.
 *
 * @param {string} [backendName]  Backend; Default: das aktive
 * @returns {Promise<{vorher: string, nachher: string}|null>}  null = nichts zu tun
 */
export async function heileAblageWurzel(backendName) {
  const settings = await loadDynamicSettings();
  const backend = backendName || getActiveBackendName(settings);
  const adapter = getAdapter(backend);
  if (typeof adapter.merkeAblageWurzelPfad !== 'function'
      || typeof adapter.leseAblageWurzelPfad !== 'function') return null;

  const tatsaechlich = await ermittleWurzelPfad(backend);
  if (tatsaechlich === null) return null;

  const gespeichert = await adapter.leseAblageWurzelPfad();
  if (gespeichert === tatsaechlich) return null;

  await adapter.merkeAblageWurzelPfad(tatsaechlich);
  appLog('WARN', 'storage',
    `Pfadgrenze der Ablage korrigiert (${backend}): "${gespeichert}" → "${tatsaechlich}". `
    + 'Die Ordnerstruktur liegt nicht unter dem bisher eingetragenen Ordner.');
  return { vorher: gespeichert, nachher: tatsaechlich };
}

/**
 * Ermittelt den aktuell konfigurierten Wurzelordner-Pfad eines Backends.
 *
 * Der Pfad selbst wird nirgends gespeichert — persistiert sind nur die
 * Ordner-IDs in _settings.storage_folders[<backend>]. Er wird deshalb aus einem
 * bereits konfigurierten Systemordner zurückgerechnet: dessen Pfad minus das
 * letzte Segment ist genau der Wert, den setupFolderStructure() als
 * rootFolderPath erwartet (beide Adapter liefern getPath() relativ zu dem
 * getRoot(), von dem auch die Ordneranlage ausgeht).
 *
 * Das ist die einzige verlässliche Quelle für die Vorbelegung des
 * Setup-Assistenten. Eine feste Vorgabe wie "postbuch" wäre auf jeder Instanz
 * mit abweichendem Wurzelordner schlicht falsch — und der Assistent zieht
 * anschließend alle Dokumente dorthin um.
 *
 * @param {string} [backendName]  Backend; Default: das aktive
 * @returns {Promise<string|null>}  z. B. "postbuch_testinstanz", oder null,
 *                                  wenn (noch) nichts konfiguriert bzw. der
 *                                  Ordner nicht mehr auflösbar ist
 */
export async function ermittleWurzelPfad(backendName) {
  const settings = await loadDynamicSettings();
  const backend = backendName || getActiveBackendName(settings);
  const folders = getFolders(settings, backend);

  // Nur Systemordner: sie liegen garantiert direkt unter dem Wurzelordner.
  // Lebensbereichs- und L/D-Ordner tun das nicht (bzw. nicht auf einer Ebene).
  for (const def of SYSTEM_FOLDERS) {
    const id = def.keys.map((k) => folders[k]).find(Boolean);
    if (!id) continue;
    try {
      const pfad = await getAdapter(backend).getPath(id);
      const segmente = String(pfad || '').split('/').filter(Boolean);
      if (segmente.pop() !== def.folder) continue;   // Ordner umbenannt/verschoben
      return segmente.join('/');                     // "" = direkt in der Wurzel
    } catch {
      // Ordner gelöscht oder Backend gerade nicht erreichbar → nächsten versuchen
    }
  }
  return null;
}

/**
 * Schreibt Ordner-IDs nach _settings.storage_folders[<backend>].
 * Nur die übergebenen Keys werden gesetzt; alles andere bleibt stehen — auch
 * die Ordner des jeweils anderen Backends (jsonb-Merge auf oberster Ebene).
 *
 * @param {string} backend            Backend-Name
 * @param {Record<string,string>} patch  { folderKey: id, … }
 * @param {object} [settings]         bereits geladene Settings (spart eine Abfrage)
 */
export async function saveFolderIds(backend, patch) {
  if (!patch || typeof patch !== 'object' || Object.keys(patch).length === 0) return {};
  await db.query(
    `INSERT INTO postbuch._settings AS s (key, value, updated_at)
     VALUES ('storage_folders', jsonb_build_object($1::text, $2::jsonb), NOW())
     ON CONFLICT (key) DO UPDATE
       SET value = jsonb_set(COALESCE(s.value, '{}'::jsonb), ARRAY[$1::text],
                    COALESCE(s.value->$1::text, '{}'::jsonb) || $2::jsonb, true),
           updated_at = NOW()`,
    [backend, JSON.stringify(patch)]
  );
  return patch;
}

// ── Ablageebenen ──────────────────────────────────────────────────────────────
//
// Der Zielordner eines Dokuments ist eine Kette von Ordnern unter der Wurzel,
// eine Ebene je Eintrag aus getAblageEbenen(). Jeder Ordner der Kette hat in
// storage_folders[<backend>] einen Cache-Schlüssel, der den logischen Pfad
// von der Wurzel bis zu ihm beschreibt: die Segmente aller Ebenen bis
// einschließlich seiner eigenen, mit `/` verbunden. Gleicher Schlüssel heißt
// damit gleicher logischer Ort, unabhängig davon, aus welcher Struktur er
// stammt. Die Segmente sind je Ebene unterscheidbar:
//
//   Lebensbereich  <code>              (wie seit der LxD-Ablage)
//   Dokumentart    <code>              (wie seit der LxD-Ablage)
//   Person         @<mensch-uuid> | @gemeinsam
//   Jahr           jahr:<JJJJ> | jahr:ohne
//   Richtung       richtung:eingang | richtung:ausgang
//
// Für die beiden Vorlagen ergeben sich exakt die bisherigen Schlüssel
// (`<L>`, `<L>/<D>`, `@…/<L>/<D>`); bestehende Caches bleiben gültig.

/** Ordner für Dokumente ohne Familienmitglied bei Ablage nach Person. */
export const GEMEINSAM_ORDNER = 'Gemeinsam';
/** Ordner für Dokumente ohne Briefdatum bei Ablage nach Jahr. */
export const OHNE_DATUM_ORDNER = 'Ohne Datum';
/** Ordnernamen der Ebene Richtung. */
export const RICHTUNG_ORDNER = Object.freeze({ eingang: 'Eingang', ausgang: 'Ausgang' });

const JAHR_PRAEFIX = 'jahr:';
const RICHTUNG_PRAEFIX = 'richtung:';

/**
 * Cache-Schlüsselsegment eines Personenordners. Eigener Namensraum mit `@`,
 * damit er nie mit einem Lebensbereichs-, Dokumentart- oder
 * Systemordner-Schlüssel verwechselt wird. Die Person hängt an der Mensch-UUID,
 * nicht am Kurznamen – eine Umbenennung ändert nur den Ordnernamen.
 */
export function personSchluessel(menschId) {
  return menschId ? `@${menschId}` : '@gemeinsam';
}

/** Jahr des Briefdatums ('YYYY-MM-DD' oder Date) als vierstelliger String, sonst null. */
export function ablageJahr(briefdatum) {
  if (briefdatum instanceof Date) return Number.isNaN(briefdatum.getTime()) ? null : String(briefdatum.getFullYear());
  const m = /^(\d{4})-\d{2}-\d{2}/.exec(typeof briefdatum === 'string' ? briefdatum.trim() : '');
  return m ? m[1] : null;
}

/** Richtung einer Zeile; fehlend oder unbekannt zählt wie der DB-Default 'eingang'. */
function ablageRichtung(richtung) {
  return richtung === 'ausgang' ? 'ausgang' : 'eingang';
}

/** Segment einer Ebene im Cache-Schlüssel. menschId muss bereits aufgelöst sein. */
function segment(ebene, row, menschId) {
  switch (ebene) {
    case 'lebensbereich': return row.lebensbereich;
    case 'dokumentart': return row.dokumentart;
    case 'person': return personSchluessel(menschId);
    case 'jahr': return `${JAHR_PRAEFIX}${ablageJahr(row.briefdatum) ?? 'ohne'}`;
    case 'richtung': return `${RICHTUNG_PRAEFIX}${ablageRichtung(row.richtung)}`;
    default: throw new Error(`Unbekannte Ablageebene "${ebene}".`);
  }
}

/**
 * Prüft, ob ein Schlüsselsegment zu einer Ebene passt. Lebensbereich und
 * Dokumentart werden gegen die Taxonomie geprüft, die übrigen am Präfix.
 */
function segmentPasst(ebene, seg, codes) {
  switch (ebene) {
    case 'lebensbereich': return codes.lebensbereiche.has(seg);
    case 'dokumentart': return codes.dokumentarten.has(seg);
    case 'person': return seg.startsWith('@');
    case 'jahr': return seg.startsWith(JAHR_PRAEFIX);
    case 'richtung': return seg.startsWith(RICHTUNG_PRAEFIX);
    default: return false;
  }
}

function taxonomieCodes(taxonomie) {
  return {
    lebensbereiche: new Set(taxonomie.lebensbereiche.map((x) => x.code)),
    dokumentarten: new Set(taxonomie.dokumentarten.map((x) => x.code)),
  };
}

/**
 * Liefert eine Funktion, die entscheidet, ob ein Cache-Schlüssel ein Ordner
 * irgendeiner Ablagestruktur ist. System- und Legacy-Schlüssel (inbox,
 * abrechnung, 'Wohnen' …) sind es nicht.
 */
export function istStrukturSchluessel(taxonomie) {
  const codes = taxonomieCodes(taxonomie);
  return (key) => key.split('/').every((seg) => ABLAGE_EBENEN.some((e) => segmentPasst(e, seg, codes)));
}

/**
 * Liefert eine Funktion, die entscheidet, ob ein Cache-Schlüssel zur
 * Ablagestruktur mit den angegebenen Ebenen gehört (Präfix ihrer Kette).
 */
export function gehoertZurStruktur(ebenen, taxonomie) {
  const codes = taxonomieCodes(taxonomie);
  return (key) => {
    const segs = key.split('/');
    return segs.length <= ebenen.length && segs.every((seg, i) => segmentPasst(ebenen[i], seg, codes));
  };
}

/**
 * Cache-Schlüssel des Blattordners für eine Dokumentzeile im aktuellen
 * Ablagemodus. Reine Funktion; row.menschId muss bereits aufgelöst sein.
 */
export function ablageSchluessel(settings, row) {
  return getAblageEbenen(settings).map((e) => segment(e, row, row.menschId)).join('/');
}

/**
 * Kennung des Ablageziels einer Zeile für Zwischenspeicher eines Laufs
 * (Gesamtumzug, Backend-Migration). Enthält alle Achsen, die eine Ebene
 * bestimmen können; zu fein ist unschädlich, zu grob nicht.
 */
export function ablageZielKennung(row) {
  return [row.familienmitglied ?? '', row.behandelte_person ?? '', row.lebensbereich, row.dokumentart,
    ablageJahr(row.briefdatum) ?? '', ablageRichtung(row.richtung)].join('|');
}

/**
 * SQL-Ausdruck für die eindeutige behandelte Person eines Dokuments, als
 * Spalte `behandelte_person` in Zeilen für ensureAblageOrdner(). Arztrechnung
 * und Arztbericht tragen genau eine; ein Erstattungsbescheid nur dann, wenn
 * alle Positionen dieselbe Person nennen. Sonst NULL.
 *
 * @param {string} alias  Alias von postbuch.postbuch in der Abfrage
 */
export function behandeltePersonSql(alias) {
  return `COALESCE(
      (SELECT ar.behandelte_person FROM postbuch.arztrechnung ar WHERE ar.postid = ${alias}.postid),
      (SELECT ab.behandelte_person FROM postbuch.arztbericht ab WHERE ab.postid = ${alias}.postid),
      (SELECT CASE WHEN count(DISTINCT ep.behandelte_person) = 1 AND count(ep.behandelte_person) = count(*)
                   THEN min(ep.behandelte_person) END
         FROM postbuch.erstattungsbescheid_einzelposition ep WHERE ep.postid = ${alias}.postid)
    )`;
}

/**
 * Löst familienmitglied (exakter Kurzname) auf die Mensch-UUID auf.
 * Kein Treffer oder kein familienmitglied → null (Sammelordner).
 */
export async function ermittlePerson(familienmitglied) {
  if (!familienmitglied) return null;
  const r = await db.query('SELECT id, kurzname FROM postbuch.mensch WHERE kurzname = $1', [familienmitglied]);
  return r.rows[0] ?? null;
}

/**
 * Mensch, dessen Ordner ein Dokument bei Ablage nach Person bekommt. Bei
 * Personenquelle 'behandelt' zählt die behandelte Person bzw. das Tier, sofern
 * sie einem erfassten Menschen entspricht; sonst der Adressat.
 */
export async function ermittleAblagePerson(settings, row) {
  if (getAblagePersonQuelle(settings) === 'behandelt' && row.behandelte_person) {
    const behandelt = await ermittlePerson(row.behandelte_person);
    if (behandelt) return behandelt;
  }
  return ermittlePerson(row.familienmitglied);
}

/** OneDrive verbietet u. a. Schrägstriche in Ordnernamen. */
function ordnerName(label) {
  return String(label).replace(/[\\/:*?"<>|]/g, ' – ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Liefert (und legt lazy an) den Zielordner eines Dokuments im aktuellen
 * Ablagemodus. Einziger Einstieg für alle Ablagepfade (Pipeline, Import,
 * Typwechsel, PDF-Ersatz, Umzug, Backend-Migration).
 *
 * @param {object} settings
 * @param {{lebensbereich:string, dokumentart:string, familienmitglied?:string|null,
 *          behandelte_person?:string|null, briefdatum?:string|Date|null,
 *          richtung?:string|null}} row
 * @param {string} [backendName]  Default: aktives Backend
 * @param {{force?:boolean}} [opts]  force=true überspringt die Cache-Treffer und
 *   löst die gesamte Ordnerkette ab der AKTUELLEN Wurzel neu auf. Gebraucht vom
 *   Gesamtumzug nach einem Wurzelordner- oder Strukturwechsel: gecachte
 *   Schlüssel können dann noch auf ihren alten (dort weiterhin gültigen) Ort
 *   zeigen – etwa ein Ordner, der beim Aufräumen wegen fremder Inhalte stehen
 *   blieb. Ohne Erzwingen würde relocateAllDocuments() solche Ziele
 *   fälschlich als "schon am richtigen Ort" behandeln.
 *   laufCache (Map) gilt für genau einen Gesamtlauf: Jeder Ordner der Kette
 *   (und die Wurzel unter dem Schlüssel '') wird darin höchstens einmal
 *   erzwungen aufgelöst, auch wenn viele Ziele ihn teilen. Gespeichert wird das
 *   Promise, damit parallele Aufrufe auf dieselbe Auflösung warten, statt den
 *   Ordner gleichzeitig anzulegen (Nextcloud antwortet darauf mit 423 Locked).
 */
export async function ensureAblageOrdner(settings, row, backendName, opts = {}) {
  const { lebensbereich: lCode, dokumentart: dCode } = row;
  if (typeof lCode !== 'string' || typeof dCode !== 'string') {
    throw new Error('Ablageziel braucht Lebensbereich und Dokumentart.');
  }
  const backend = backendName || getActiveBackendName(settings);
  const ebenen = getAblageEbenen(settings);
  const person = ebenen.includes('person') ? await ermittleAblagePerson(settings, row) : null;
  const segmente = ebenen.map((e) => segment(e, row, person?.id));
  const schluessel = segmente.map((_, i) => segmente.slice(0, i + 1).join('/'));
  const folders = getFolders(settings, backend);
  const leafKey = schluessel[schluessel.length - 1];
  if (folders[leafKey] && !opts.force) return folders[leafKey];

  // Bestandsdokumente duerfen weiterhin in Taxonomie-Zellen liegen, die erst
  // nach ihrer Ablage deaktiviert wurden. Nur der Setup-Wizard und die neue
  // Klassifikation arbeiten aktiv-only; die Ordneraufloesung braucht alle.
  const taxonomie = await getGesamteTaxonomie();
  const lebensbereich = taxonomie.lebensbereiche.find((x) => x.code === lCode);
  const dokumentart = taxonomie.dokumentarten.find((x) => x.code === dCode);
  if (!lebensbereich || !dokumentart) throw new Error(`Unbekannte LxD-Zelle "${lCode}/${dCode}".`);

  // OneDrive verbietet u.a. Schrägstriche, die in lesbaren Taxonomie-Labels
  // fachlich sinnvoll sein können. Der technische Ordnername bleibt stabil,
  // die Anzeige in der App kommt weiterhin aus der unveränderten Taxonomie.
  const namen = {
    lebensbereich: lebensbereich.label,
    dokumentart: dokumentart.label,
    person: person ? person.kurzname : GEMEINSAM_ORDNER,
    jahr: ablageJahr(row.briefdatum) ?? OHNE_DATUM_ORDNER,
    richtung: RICHTUNG_ORDNER[ablageRichtung(row.richtung)],
  };

  const adapter = getAdapter(backend);
  const anchorId = folders.inbox || folders.failed || folders.suspended || folders.trash;
  if (!anchorId) throw new Error(`Ablage für Backend "${backend}" ist noch nicht eingerichtet.`);

  const istStruktur = istStrukturSchluessel(taxonomie);
  const laufCache = opts.laufCache;
  // Einmal je Lauf: Fehlschläge werden nicht zwischengespeichert, das nächste
  // Ziel versucht es erneut.
  const einmalJeLauf = (key, fn) => {
    if (!laufCache) return fn();
    if (!laufCache.has(key)) {
      const p = fn();
      laufCache.set(key, p);
      p.catch(() => laufCache.delete(key));
    }
    return laufCache.get(key);
  };
  const patch = {};
  const loese = (key, parentId, name) => einmalJeLauf(key, async () => {
    if (folders[key] && !opts.force) return folders[key];
    const { id } = await adapter.findOrCreateFolder(parentId, ordnerName(name), { strict: true });
    // Dieselbe Ordner-ID unter einem anderen Strukturschlüssel hieße: zwei
    // logische Ziele teilen sich einen physischen Ordner (z. B. Kurzname =
    // Lebensbereich nach späterer Umbenennung eines Labels). Lieber abbrechen
    // als vermischen. System- und Legacy-Schlüssel teilen sich Ordner
    // dagegen bewusst (etwa 'Wohnen' und 'wohnen') und zählen nicht.
    const fremd = Object.entries(folders).find(([k, v]) => v === id && k !== key && istStruktur(k));
    if (fremd) {
      throw new Error(`Ordner "${name}" ist bereits als "${fremd[0]}" belegt – Namenskollision in der Ablage.`);
    }
    patch[key] = id;
    folders[key] = id;
    return id;
  });

  let parentId = await einmalJeLauf('', async () => (await adapter.getMeta(anchorId)).parentId);
  for (let i = 0; i < ebenen.length; i++) {
    parentId = await loese(schluessel[i], parentId, namen[ebenen[i]]);
  }
  await saveFolderIds(backend, patch);
  return parentId;
}

/** Liegt der Ordner eines Cache-Schlüssels in oder unter einem Personenordner des Menschen? */
export function istPersonenSchluessel(key, menschId) {
  return key.split('/').includes(personSchluessel(menschId));
}

/**
 * Entfernt alle Cache-Schlüssel einer Person (jeder Schlüssel mit dem Segment
 * `@<uuid>`, gleich auf welcher Ebene) aus allen Backends.
 * Nach dem Löschen eines Menschen, damit ein später gleichnamig angelegter
 * Mensch nicht an der ID-Kollisionsprüfung scheitert.
 */
export async function entfernePersonenSchluessel(menschId) {
  if (!menschId) return;
  const praefix = personSchluessel(menschId);
  await db.query(
    `UPDATE postbuch._settings s
        SET value = (
              SELECT COALESCE(jsonb_object_agg(b.key, (
                       SELECT COALESCE(jsonb_object_agg(f.key, f.value), '{}'::jsonb)
                         FROM jsonb_each(b.value) f
                        WHERE '/' || f.key || '/' NOT LIKE '%/' || $1 || '/%'
                     )), '{}'::jsonb)
                FROM jsonb_each(s.value) b
            ),
            updated_at = NOW()
      WHERE s.key = 'storage_folders'`,
    [praefix],
  );
}

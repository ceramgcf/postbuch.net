/**
 * service/onedrive-zugriff.js — Zugriffsumfang der OneDrive-Verbindung umstellen
 *
 * Zwei Zustände (lib/storage/onedrive.js, zugriffsModus()):
 *   'appordner'   Files.ReadWrite.AppFolder – die Ablage liegt im App-Ordner
 *                 unter Apps/, postbuch.net sieht nichts außerhalb davon.
 *   'vollzugriff' Files.ReadWrite.All – die Ablage kann überall liegen.
 *
 * Es gibt immer nur EINE Verbindung. Der Umzug läuft deshalb in zwei Hälften
 * mit einer Neuanmeldung dazwischen:
 *
 *   Hin (→ appordner)
 *     1. Mit der bestehenden, breiten Anmeldung den Inhalt des
 *        postbuch.net-Wurzelordners direkt in den App-Ordner schieben (PATCH,
 *        IDs bleiben). Der App-Ordner ist danach selbst die Ablagewurzel.
 *     2. Modus setzen, Tokens löschen. Der Admin trennt postbuch.net im
 *        Microsoft-Konto und verbindet neu – jetzt nur mit App-Ordner-Scope.
 *     3. Nach dem Verbinden (afterOnedriveConnected → setzeFort): alle
 *        Ordner-IDs und eine Stichprobe der Dokumente prüfen, dazu die
 *        Wirksamkeitsprobe. Reicht die Anmeldung noch über den App-Ordner
 *        hinaus, wartet der Umzug auf den Widerruf bei Microsoft.
 *
 *   Zurück (→ vollzugriff)
 *     1. Modus setzen, Tokens löschen. Der Admin verbindet neu und stimmt dem
 *        Vollzugriff zu.
 *     2. Nach dem Verbinden den Inhalt des App-Ordners in einen Ablageordner
 *        am früheren Ort (oder in der Laufwerkswurzel) zurückschieben und
 *        prüfen.
 *
 * Zwischen Start und Abschluss ist die Pipeline pausiert. Der Zustand liegt
 * in _settings.onedrive_zugriff_umzug, damit er einen Neustart übersteht.
 */

import pool from '../db.js';
import * as pipelineQueue from '../jobs/pipeline-queue.js';
import { appLog } from '../app-log.js';
import { loadDynamicSettings, getFolders } from '../config.js';
import * as onedrive from '../lib/storage/onedrive.js';
import { istUmzugAktiv } from './storage-relocate.js';
import { SYSTEM_FOLDERS, entferneOrdnerSchluessel } from './storage-setup.js';

const ZUSTAND_KEY = 'onedrive_zugriff_umzug';
const PAUSE_GRUND = 'OneDrive-Zugriff wird umgestellt';
const STICHPROBE = 200;

/** Phasen, in denen die Pipeline pausiert bleibt. */
const PAUSIERT_IN = new Set(['warte_auf_verbindung', 'fehler']);

let _laeuft = false;

async function setzeSetting(key, value) {
  await pool.query(
    `INSERT INTO _settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [key, JSON.stringify(value)],
  );
}

async function leseZustand() {
  const r = await pool.query('SELECT value FROM _settings WHERE key = $1', [ZUSTAND_KEY]);
  return r.rows[0]?.value || null;
}

async function schreibeZustand(zustand) {
  await setzeSetting(ZUSTAND_KEY, zustand);
}

function fehler(text, statusCode = 409) {
  const e = new Error(text);
  e.statusCode = statusCode;
  return e;
}

/** Item-IDs der eingerichteten OneDrive-Ordner, nach Schlüssel. */
function ordnerVon(settings) {
  return Object.entries(getFolders(settings, 'onedrive'))
    .filter(([, id]) => typeof id === 'string' && onedrive.isValidId(id));
}

/** Wurzelordner der Ablage = Elternordner des Eingangsordners. */
async function ermittleWurzelId(settings) {
  const inbox = getFolders(settings, 'onedrive').inbox;
  if (!inbox) return null;
  const meta = await onedrive.getMeta(inbox);
  return meta.parentId;
}

/**
 * Öffentliche Sicht für die Einstellungen. Item-IDs bleiben draußen, sie sagen
 * dem Admin nichts.
 */
export async function getStatus() {
  const settings = await loadDynamicSettings();
  const z = await leseZustand();
  const modus = onedrive.zugriffsModusAus(settings);
  let appOrdnerName = null;
  if (modus === 'appordner' && settings.onedrive_tokens) {
    appOrdnerName = await onedrive.getAppOrdnerGemerkt().then((a) => a.name).catch(() => null);
  }
  return {
    modus,
    appOrdnerName,
    laeuft: _laeuft,
    umzug: z && {
      ziel: z.ziel,
      phase: z.phase,
      gestartetAm: z.gestartetAm,
      abgeschlossenAm: z.abgeschlossenAm || null,
      fehler: z.fehler || null,
      pruefung: z.pruefung || null,
      wurzelName: z.wurzelName || null,
      quittiert: z.quittiert === true,
      unterbrochen: !!(z.quelleId || z.rueckZielId),
    },
  };
}

async function pruefeVoraussetzungen() {
  if (_laeuft) throw fehler('Die Umstellung läuft bereits.');
  if (istUmzugAktiv()) throw fehler('Gerade läuft ein Ablage-Umzug. Bitte warten, bis er fertig ist.');
  // Nur ein Lauf, der gerade kopiert, verträgt kein Verschieben der Wurzel.
  // Fertige oder angehaltene Läufe arbeiten mit Item-IDs, die dabei gleich
  // bleiben (getOffenenLauf() liefert auch längst aufgeräumte Läufe).
  const { rows } = await pool.query(
    `SELECT 1 FROM postbuch._storage_migration_runs
      WHERE status = 'laeuft' AND 'onedrive' IN (src_backend, dst_backend) LIMIT 1`,
  );
  if (rows.length > 0) {
    throw fehler('Gerade läuft eine Ablage-Migration mit OneDrive. Bitte warten, bis sie fertig ist.');
  }
}

/**
 * Pausiert die Pipeline und wartet auf Leerlauf.
 * @returns {boolean} true, wenn diese Umstellung die Pause gesetzt hat
 */
async function pausiere() {
  const eigenePause = !pipelineQueue.isPaused();
  pipelineQueue.pause(PAUSE_GRUND);
  const leer = await pipelineQueue.warteAufLeerlauf(60000);
  if (!leer) {
    if (eigenePause) pipelineQueue.resume();
    throw fehler('Es laufen noch Verarbeitungen. Bitte in einer Minute erneut versuchen.');
  }
  return eigenePause;
}

async function trenneAnmeldung() {
  await pool.query("DELETE FROM _settings WHERE key = 'onedrive_tokens'");
  onedrive.resetMsalClient();
}

/**
 * Hinweg: Der Inhalt des Ablageordners wandert direkt in den App-Ordner, der
 * App-Ordner wird selbst zur Ablagewurzel. Verschoben wird jedes Kind
 * einzeln (IDs bleiben), danach kommt der leere Ablageordner in den
 * OneDrive-Papierkorb.
 *
 * Bricht das mittendrin ab, steht die Quelle als `quelleId` im Zustand; ein
 * erneuter Start setzt dort fort. Bis dahin arbeitet alles weiter, weil die
 * Anmeldung noch breit ist und Graph über IDs adressiert.
 *
 * Liegt die Ablage schon als Unterordner im App-Ordner (Einrichtung mit
 * eigenem Wurzelordner), bleibt sie dort.
 */
async function verschiebeInAppOrdner(settings, vorher, zustand) {
  const appOrdner = await onedrive.getAppOrdner();

  // Fortsetzen: unterbrochener Hinweg (quelleId) oder unterbrochener
  // Rückweg (rueckZielId, der dafür angelegte Ordner).
  let quelleId = null;
  for (const id of [vorher?.quelleId, vorher?.rueckZielId]) {
    if (!id || quelleId) continue;
    const quelle = await onedrive.getMeta(id).catch(() => null);
    if (quelle?.isFolder) quelleId = quelle.id;
  }

  if (!quelleId) {
    const wurzelId = await ermittleWurzelId(settings);
    if (wurzelId === appOrdner.id) return;
    const wurzel = await onedrive.getMeta(wurzelId);
    if (wurzel.parentId === appOrdner.id) return;
    if (!wurzel.parentId) {
      throw fehler('Die Ablage liegt direkt in der OneDrive-Wurzel und lässt sich nicht als Ganzes verschieben. Bitte sie zuerst per Ablage-Migration in einen eigenen Ordner legen.');
    }

    // Alles, was nicht unter dem Wurzelordner liegt, wäre danach
    // unerreichbar. Dann lieber gar nicht erst verschieben.
    const wurzelPfad = await onedrive.getPath(wurzelId);
    const ausserhalb = [];
    const verwaist = [];
    for (const [key, id] of ordnerVon(settings)) {
      let pfad = null;
      try {
        pfad = await onedrive.getPath(id);
      } catch (err) {
        if (err.status === 404) { verwaist.push(key); continue; }
      }
      if (!pfad || !(pfad === wurzelPfad || pfad.startsWith(`${wurzelPfad}/`))) ausserhalb.push(key);
    }
    if (ausserhalb.length > 0) {
      throw fehler(`Diese Ordner liegen nicht unter dem Ablageordner „${wurzel.name}“ und wären danach unerreichbar: ${ausserhalb.slice(0, 10).join(', ')}${ausserhalb.length > 10 ? ' …' : ''}`);
    }

    // Gelöschte Ablageordner legt die Ablage bei Bedarf neu an, sobald ihr
    // Eintrag fehlt. Ein fehlender Systemordner braucht den Setup-Assistenten.
    const systemKeys = new Set(SYSTEM_FOLDERS.flatMap((d) => d.keys));
    const fehlenderSystemordner = verwaist.filter((k) => systemKeys.has(k));
    if (fehlenderSystemordner.length > 0) {
      throw fehler(`Diese Systemordner gibt es in OneDrive nicht mehr: ${fehlenderSystemordner.join(', ')}. Bitte zuerst die Ordnerstruktur mit dem Setup-Assistenten neu anlegen.`);
    }

    // Ein belegter App-Ordner ließe sich danach nicht mehr von der Ablage
    // trennen, auch nicht für den Rückweg.
    const belegt = await onedrive.listChildren(appOrdner.id);
    if (belegt.length > 0) {
      throw fehler(`Der App-Ordner „${appOrdner.name}“ unter Apps/ ist nicht leer. Bitte seinen Inhalt zuerst an einen anderen Ort verschieben.`);
    }

    if (verwaist.length > 0) {
      await entferneOrdnerSchluessel('onedrive', verwaist);
      appLog('INFO', 'onedrive', `Einträge gelöschter Ablageordner entfernt, sie entstehen bei Bedarf neu: ${verwaist.join(', ')}`);
    }

    quelleId = wurzelId;
    zustand.herkunftId = wurzel.parentId;
    zustand.wurzelName = wurzel.name;
  }

  await schreibeZustand({
    ...zustand,
    phase: 'fehler',
    fehler: 'Das Verschieben in den App-Ordner wurde unterbrochen. Bitte die Umstellung auf den App-Ordner erneut starten.',
    quelleId,
  });
  const kinder = await onedrive.listChildren(quelleId);
  for (const kind of kinder) {
    const neu = await onedrive.verschiebeOrdner(kind.id, appOrdner.id);
    if (neu.parentId !== appOrdner.id) throw new Error(`„${kind.name}“ liegt nach dem Verschieben nicht im App-Ordner.`);
  }
  const rest = await onedrive.listChildren(quelleId);
  if (rest.length > 0) throw new Error('Der Ablageordner ist nach dem Verschieben nicht leer.');
  await onedrive.remove(quelleId).catch((err) => {
    appLog('WARN', 'onedrive', `Leerer Ablageordner blieb stehen: ${err.message}`);
  });
  appLog('INFO', 'onedrive', `Inhalt des Ablageordners „${zustand.wurzelName || ''}“ in den App-Ordner verschoben (${kinder.length} Einträge)`);
}

/**
 * Rückweg: Ist der App-Ordner selbst die Ablagewurzel, entsteht am früheren
 * Ort (sonst in der Laufwerkswurzel) ein Ablageordner, und der Inhalt des
 * App-Ordners wandert hinein. Das Ziel steht als `rueckZielId` im Zustand,
 * damit ein Abbruch dort fortsetzt. Ein Unterordner im App-Ordner wird wie
 * bisher als Ganzes zurückgeschoben.
 */
async function verschiebeAusAppOrdner(settings, z) {
  const appOrdner = await onedrive.getAppOrdner();

  // Unterbrochener Hinweg: die ursprüngliche Quelle ist das natürliche Ziel.
  let zielId = null;
  for (const id of [z.rueckZielId, z.quelleId]) {
    if (!id || zielId) continue;
    const meta = await onedrive.getMeta(id).catch(() => null);
    if (meta?.isFolder) zielId = meta.id;
  }

  const wurzelId = await ermittleWurzelId(settings);
  if (!zielId && wurzelId !== appOrdner.id) {
    const wurzel = await onedrive.getMeta(wurzelId);
    if (wurzel.parentId !== appOrdner.id) return;
    const neu = await onedrive.verschiebeOrdner(wurzelId, await rueckOrt(z));
    z.wurzelName = neu.name;
    appLog('INFO', 'onedrive', `Ablageordner „${neu.name}“ aus dem App-Ordner zurückverschoben`);
    return;
  }

  if (!zielId) {
    const name = z.wurzelName || 'postbuch';
    zielId = (await onedrive.createFolder(await rueckOrt(z), name)).id;
    z.rueckZielId = zielId;
    await schreibeZustand(z);
  }
  const kinder = await onedrive.listChildren(appOrdner.id);
  for (const kind of kinder) {
    const neu = await onedrive.verschiebeOrdner(kind.id, zielId);
    if (neu.parentId !== zielId) throw new Error(`„${kind.name}“ liegt nach dem Verschieben nicht im Ablageordner.`);
  }
  const ziel = await onedrive.getMeta(zielId);
  z.wurzelName = ziel.name;
  delete z.rueckZielId;
  delete z.quelleId;
  appLog('INFO', 'onedrive', `Inhalt des App-Ordners nach „${ziel.name}“ zurückverschoben (${kinder.length} Einträge)`);
}

/** Früherer Ort der Ablage, sonst die Laufwerkswurzel. */
async function rueckOrt(z) {
  if (z.herkunftId) {
    const herkunft = await onedrive.getMeta(z.herkunftId).catch(() => null);
    if (herkunft?.isFolder) return herkunft.id;
  }
  return (await onedrive.getLaufwerksWurzel()).id;
}

/**
 * Startet die Umstellung in eine Richtung.
 * @param {'appordner'|'vollzugriff'} ziel
 */
export async function starteUmstellung(ziel) {
  if (ziel !== 'appordner' && ziel !== 'vollzugriff') throw fehler('Unbekanntes Ziel.', 400);
  await pruefeVoraussetzungen();
  const settings = await loadDynamicSettings();
  const modus = onedrive.zugriffsModusAus(settings);
  const vorher = await leseZustand();
  if (modus === ziel && !(vorher && vorher.phase !== 'abgeschlossen')) {
    throw fehler(ziel === 'appordner' ? 'Der App-Ordner-Modus ist bereits aktiv.' : 'Der Vollzugriff ist bereits aktiv.');
  }

  _laeuft = true;
  let pausiert = false;
  let eigenePause = false;
  try {
    const verbunden = !!settings.onedrive_tokens;
    const ordner = ordnerVon(settings);
    const zustand = {
      ziel,
      phase: 'warte_auf_verbindung',
      gestartetAm: new Date().toISOString(),
      // Früherer Ort der Ablage für den Rückweg. Ein Wechsel der Richtung
      // mitten im Umzug darf ihn nicht verlieren.
      herkunftId: vorher?.herkunftId || null,
      wurzelName: vorher?.wurzelName || null,
    };
    // Ein unterbrochenes Verschieben setzt der Rückweg dort fort.
    if (ziel === 'vollzugriff') {
      if (vorher?.quelleId) zustand.quelleId = vorher.quelleId;
      if (vorher?.rueckZielId) zustand.rueckZielId = vorher.rueckZielId;
    }

    if (ordner.length > 0) {
      eigenePause = await pausiere();
      pausiert = true;
    }

    if (ziel === 'appordner' && ordner.length > 0) {
      // Hin: Verschieben geht nur mit der bestehenden, breiten Anmeldung.
      if (!verbunden) {
        throw fehler('OneDrive ist nicht verbunden. Bitte zuerst verbinden, dann umstellen.');
      }
      await verschiebeInAppOrdner(settings, vorher, zustand);
    }

    await setzeSetting('onedrive_zugriff', ziel);
    await trenneAnmeldung();
    await schreibeZustand(zustand);
    appLog('INFO', 'onedrive', `Zugriff wird auf ${ziel === 'appordner' ? 'App-Ordner' : 'Vollzugriff'} umgestellt – Neuverbindung erforderlich`);
    // Ohne Ordnerstruktur gibt es nichts zu prüfen oder zu pausieren.
    if (!pausiert) {
      zustand.phase = 'abgeschlossen';
      zustand.abgeschlossenAm = new Date().toISOString();
      await schreibeZustand(zustand);
    }
    return getStatus();
  } catch (err) {
    if (eigenePause) pipelineQueue.resume();
    throw err;
  } finally {
    _laeuft = false;
  }
}

/**
 * Zweite Hälfte nach einer neuen Anmeldung. Wird aus afterOnedriveConnected
 * aufgerufen und lässt sich manuell wiederholen. Wirft nicht; das Ergebnis
 * steht im Zustand.
 */
export async function setzeFort() {
  const z = await leseZustand();
  if (!z || z.phase === 'abgeschlossen') return getStatus();
  if (_laeuft) return getStatus();
  _laeuft = true;
  try {
    if (z.ziel === 'appordner' && z.quelleId) {
      throw fehler('Das Verschieben in den App-Ordner wurde unterbrochen. Bitte die Umstellung auf den App-Ordner erneut starten.');
    }
    const settings = await loadDynamicSettings();
    if (!settings.onedrive_tokens) throw fehler('OneDrive ist nicht verbunden.');
    const ordner = ordnerVon(settings);
    const vollzugriff = await onedrive.hatVollzugriff();

    if (z.ziel === 'vollzugriff') {
      if (!vollzugriff) {
        throw fehler('Microsoft hat den Vollzugriff nicht erteilt. Bitte die Verbindung trennen und bei der Anmeldung dem Zugriff auf alle Dateien zustimmen.');
      }
      if (ordner.length > 0) await verschiebeAusAppOrdner(settings, z);
    }

    z.pruefung = await pruefeErreichbarkeit(ordner);
    z.pruefung.vollzugriff = vollzugriff;
    if (z.pruefung.ordnerFehlend.length > 0 || z.pruefung.dokumenteFehlend > 0) {
      throw fehler('Nach der Umstellung sind nicht alle Ordner oder Dokumente erreichbar. Details stehen in der Prüfung.');
    }

    // Hin: Reicht die Anmeldung noch über den App-Ordner hinaus, hat Microsoft
    // die frühere Zustimmung behalten. Der Betrieb läuft, aber der Umzug ist
    // erst fertig, wenn die Probe scheitert.
    z.phase = (z.ziel === 'appordner' && vollzugriff) ? 'warte_auf_widerruf' : 'abgeschlossen';
    z.fehler = null;
    if (z.phase === 'abgeschlossen') z.abgeschlossenAm = new Date().toISOString();
    await schreibeZustand(z);
    pipelineQueue.resume();
    appLog('INFO', 'onedrive', z.phase === 'abgeschlossen'
      ? 'Umstellung des OneDrive-Zugriffs abgeschlossen'
      : 'App-Ordner aktiv, aber Microsoft erlaubt noch Zugriff außerhalb – Widerruf im Microsoft-Konto nötig');
  } catch (err) {
    z.phase = 'fehler';
    z.fehler = err.message;
    await schreibeZustand(z).catch(() => {});
    appLog('ERROR', 'onedrive', `Umstellung des OneDrive-Zugriffs: ${err.message}`);
  } finally {
    _laeuft = false;
  }
  return getStatus();
}

/**
 * Alle eingerichteten Ordner einzeln, dazu eine Stichprobe der Dokumente.
 * Zählt nur Fehlschläge, die auf „nicht da / kein Zugriff“ deuten; andere
 * Fehler (Netz, Drosselung) brechen die Prüfung ab, statt falsch zu zählen.
 * Direkt nach einer neuen Zustimmung meldet Graph einzelne Elemente kurz als
 * nicht erreichbar. Fehlschläge werden deshalb nach einer Pause wiederholt.
 */
async function pruefeErreichbarkeit(ordner) {
  const { rows } = await pool.query(
    `SELECT storage_id FROM postbuch.postbuch
      WHERE storage_backend = 'onedrive' AND storage_id IS NOT NULL
      ORDER BY random() LIMIT $1`,
    [STICHPROBE],
  );
  const dokumente = rows.map((r) => r.storage_id).filter((id) => onedrive.isValidId(id));

  const erreichbar = async (id) => {
    try {
      await onedrive.getMeta(id);
      return true;
    } catch (err) {
      if ([401, 403, 404].includes(err.status)) return false;
      throw err;
    }
  };

  let ordnerFehlend = [];
  for (const [key, id] of ordner) if (!(await erreichbar(id))) ordnerFehlend.push([key, id]);
  let dokumenteFehlend = [];
  for (const id of dokumente) if (!(await erreichbar(id))) dokumenteFehlend.push(id);

  for (let versuch = 0; versuch < 3 && (ordnerFehlend.length > 0 || dokumenteFehlend.length > 0); versuch++) {
    await new Promise((r) => setTimeout(r, 5000));
    const o = [];
    for (const [key, id] of ordnerFehlend) if (!(await erreichbar(id))) o.push([key, id]);
    const d = [];
    for (const id of dokumenteFehlend) if (!(await erreichbar(id))) d.push(id);
    ordnerFehlend = o;
    dokumenteFehlend = d;
  }

  return {
    ordnerGeprueft: ordner.length,
    ordnerFehlend: ordnerFehlend.map(([key]) => key),
    dokumenteGeprueft: rows.length,
    dokumenteFehlend: dokumenteFehlend.length,
  };
}

/** Abgeschlossenen Umzug aus der Anzeige nehmen. */
export async function quittiere() {
  const z = await leseZustand();
  if (z && z.phase !== 'abgeschlossen') throw fehler('Die Umstellung ist noch nicht abgeschlossen.');
  if (z) {
    // Herkunft für einen späteren Rückweg behalten.
    await schreibeZustand({ ziel: z.ziel, phase: 'abgeschlossen', quittiert: true, herkunftId: z.herkunftId || null, wurzelName: z.wurzelName || null, gestartetAm: z.gestartetAm, abgeschlossenAm: z.abgeschlossenAm });
  }
  return getStatus();
}

/** Beim Start: offene Umstellung hält die Pipeline weiter an. */
export async function initOnedriveZugriff() {
  const z = await leseZustand();
  if (z && PAUSIERT_IN.has(z.phase)) pipelineQueue.pause(PAUSE_GRUND);
}

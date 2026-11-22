/**
 * service/aufgabentypen-umstellung.js — einmalige Umstellung auf die beiden
 * Aufgabentypen der einfachen Modellwahl
 *
 * Früher verlangte auch die einfache Modellwahl ein Modell je Aufgabe
 * (Analysemodell, Fallback, Nachlese, vier Assistenten-/Akten-Modelle). Jetzt
 * gibt es dort nur noch „Einfach & Routine“ und „Anspruchsvoll & Komplex“
 * (`llm_aufgabe_routine`, `llm_aufgabe_komplex`, siehe model-classes.js).
 *
 * Eine bestehende Instanz bekommt beim ersten Start je Aufgabentyp das Modell,
 * das sie für die darin aufgegangenen Aufgaben am häufigsten gewählt hatte.
 * Ohne eindeutigen Spitzenreiter gilt vorläufig die erste verfügbare
 * Empfehlung für „Einfach & Routine“. Wer die einfache Modellwahl nutzt, sieht
 * danach auf dem Dashboard einen Hinweis, bis er die Auswahl in den
 * KI-Einstellungen bestätigt oder ändert (`llm_aufgaben_umstellung.offen`).
 *
 * Läuft genau einmal: Sind die Aufgabentypen schon gespeichert oder steht der
 * Umstellungsvermerk, passiert nichts. Eine frische Instanz ohne gespeicherte
 * Modelle bekommt keinen Vermerk – sie richtet die Aufgabentypen im
 * Einrichtungsassistenten ein.
 */
import db from '../db.js';
import { appLog } from '../app-log.js';
import { loadDynamicSettings } from '../config.js';
import { resolveModelConfig } from '../lib/llm.js';
import { ALTE_EINFACHE_KLASSEN, MODEL_CLASSES, modellwahl } from '../lib/llm/model-classes.js';
import { ersteVerfuegbareEmpfehlung } from '../lib/llm/empfehlungen.js';
import { invalidateAiHealthCache } from '../lib/ai-health.js';

export const VERMERK_KEY = 'llm_aufgaben_umstellung';

const schluessel = (ref) => `${ref.providerId}::${ref.model}`;

/**
 * Häufigstes Modell unter den Stimmen; null bei Gleichstand an der Spitze.
 *
 * @param {Array<{providerId, model}>} stimmen
 * @returns {{ref, anzahl}|null}
 */
export function mehrheit(stimmen) {
  const zaehler = new Map();
  for (const ref of stimmen) {
    if (!ref?.model) continue;
    const k = schluessel(ref);
    const alt = zaehler.get(k);
    zaehler.set(k, { ref, anzahl: (alt?.anzahl || 0) + 1 });
  }
  const sortiert = [...zaehler.values()].sort((a, b) => b.anzahl - a.anzahl);
  if (!sortiert.length) return null;
  if (sortiert.length > 1 && sortiert[1].anzahl === sortiert[0].anzahl) return null;
  return sortiert[0];
}

/**
 * Stimmen je Aufgabentyp aus den bisher wirksamen Modellen. Gezählt werden die
 * Klassen, die in der bisherigen Modellwahl tatsächlich benutzt wurden.
 */
export function stimmenJeAufgabe(settings) {
  const einfach = modellwahl(settings) === 'einfach';
  const quellen = einfach
    ? ALTE_EINFACHE_KLASSEN
    : MODEL_CLASSES.filter((c) => c.modus === 'gestaffelt');
  const stimmen = { routine: [], komplex: [] };
  for (const cls of quellen) {
    const cfg = resolveModelConfig(settings[cls.settingKey], cls.provider, cls.model);
    if (cfg.model) stimmen[cls.aufgabe].push({ providerId: cfg.providerId, model: cfg.model, label: cls.label });
  }
  return stimmen;
}

async function leseRoh(keys) {
  const r = await db.query('SELECT key FROM postbuch._settings WHERE key = ANY($1)', [keys]);
  return new Set(r.rows.map((x) => x.key));
}

async function schreibe(key, wert) {
  await db.query(
    `INSERT INTO postbuch._settings (key, value, updated_at) VALUES ($1, $2::jsonb, NOW())
     ON CONFLICT (key) DO UPDATE SET value = $2::jsonb, updated_at = NOW()`,
    [key, JSON.stringify(wert)],
  );
}

export async function aufgabentypenUmstellen() {
  const neu = MODEL_CLASSES.filter((c) => c.modus === 'einfach');
  const alt = MODEL_CLASSES.filter((c) => c.modus === 'gestaffelt').map((c) => c.settingKey)
    .concat('llm_model_analyse');
  const vorhanden = await leseRoh([...neu.map((c) => c.settingKey), ...alt, VERMERK_KEY]);
  if (vorhanden.has(VERMERK_KEY) || neu.some((c) => vorhanden.has(c.settingKey))) return null;
  if (!alt.some((k) => vorhanden.has(k))) return null;

  const settings = await loadDynamicSettings();
  const stimmen = stimmenJeAufgabe(settings);
  let ausweich;   // erst holen, wenn ein Aufgabentyp ihn braucht
  const ergebnis = {};
  for (const cls of neu) {
    const liste = stimmen[cls.key];
    const sieger = mehrheit(liste);
    if (sieger) {
      ergebnis[cls.key] = {
        providerId: sieger.ref.providerId, model: sieger.ref.model,
        quelle: 'mehrheit', stimmen: sieger.anzahl, von: liste.length,
      };
      continue;
    }
    if (ausweich === undefined) {
      ausweich = await ersteVerfuegbareEmpfehlung('routine').catch((err) => {
        console.warn('[aufgabentypen] Empfehlungen nicht auswertbar:', err.message);
        return null;
      });
    }
    // Ohne erreichbare Empfehlung bleibt das bisherige Modell der wichtigsten
    // Aufgabe dieses Typs (erste in der Liste) – nie ein Modell, das die
    // Instanz gar nicht eingerichtet hat.
    const ziel = ausweich || liste[0] || null;
    if (!ziel) continue;
    ergebnis[cls.key] = {
      providerId: ziel.providerId, model: ziel.model,
      quelle: ausweich ? 'empfehlung' : 'bisher', stimmen: 0, von: liste.length,
    };
  }

  for (const cls of neu) {
    const e = ergebnis[cls.key];
    if (e) await schreibe(cls.settingKey, { providerId: e.providerId, model: e.model });
  }
  const offen = modellwahl(settings) === 'einfach';
  await schreibe(VERMERK_KEY, { offen, am: new Date().toISOString(), ...ergebnis });
  invalidateAiHealthCache();

  const zeile = (key) => {
    const e = ergebnis[key];
    if (!e) return `${key}: unverändert`;
    const wie = e.quelle === 'mehrheit' ? `bei ${e.stimmen} von ${e.von} Aufgaben gewählt`
      : e.quelle === 'empfehlung' ? 'keine eindeutige Mehrheit, erste verfügbare Empfehlung' : 'keine eindeutige Mehrheit';
    return `${key}: ${e.model} (${e.providerId}) – ${wie}`;
  };
  await appLog('INFO', 'llm', 'KI-Modellwahl auf zwei Aufgabentypen umgestellt', {
    details: `${zeile('routine')}\n${zeile('komplex')}\nHinweis auf dem Dashboard: ${offen ? 'ja' : 'nein (Einzelwahl aktiv)'}`,
  });
  return ergebnis;
}

/**
 * Vermerk schließen: Der Betreiber hat die Aufgabentypen in den KI-
 * Einstellungen gespeichert. Danach verschwindet der Dashboard-Hinweis.
 */
export async function umstellungBestaetigen() {
  const r = await db.query(
    `UPDATE postbuch._settings
        SET value = jsonb_set(value, '{offen}', 'false'::jsonb), updated_at = NOW()
      WHERE key = $1 AND value->>'offen' = 'true'`,
    [VERMERK_KEY],
  );
  if (r.rowCount) invalidateAiHealthCache();
  return r.rowCount > 0;
}

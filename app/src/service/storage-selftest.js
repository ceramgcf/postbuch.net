/**
 * service/storage-selftest.js — Konformitätstest der Ablage-Schnittstelle
 *
 * Das ist ausdrücklich KEIN Nextcloud-Werkzeug, sondern der Aufnahmetest für
 * jedes Backend: er prüft, ob ein Adapter die Zusagen aus lib/storage/index.js
 * tatsächlich einhält. Dadurch lässt er sich zuerst grün gegen OneDrive
 * beweisen — der Test ist verifiziert, bevor er über ein neues Backend
 * urteilt — und er bleibt danach als Regressionsnetz stehen, statt Wegwerfcode
 * zu sein.
 *
 * ── Auflagen (Security) ────────────────────────────────────────────────────
 * • Kein Pfad, kein Dateiname, keine URL und keine Zugangsdaten aus dem
 *   Request. Alles kommt aus den persistierten Einstellungen, sonst wäre der
 *   Endpunkt ein WebDAV-Proxy ins LAN — mit Schreibrecht.
 * • Es wird ausschließlich unterhalb von `_postbuch_selftest/<uuid>/`
 *   gearbeitet und am Ende genau diese UUID wieder abgeräumt.
 * • Es werden KEINE Fremdinhalte zurückgegeben: keine Listing-Namen fremder
 *   Dateien, keine Dateiinhalte, keine ETags, keine aufgelöste IP. Nur, was
 *   der Test selbst geschrieben hat.
 * • Ein Lauf gleichzeitig, hartes Gesamtzeitlimit.
 * • Der Test schaltet NICHTS um und ruft storage-setup NICHT auf (sonst legte
 *   ein „Test" 29 Ordner an).
 */

import { createHash, randomUUID } from 'node:crypto';
import { clientSafeError } from '../lib/net-guard.js';
import { getAdapter, BACKENDS } from '../lib/storage/index.js';
import { appLog } from '../app-log.js';

const WURZEL_ORDNER = '_postbuch_selftest';
const GESAMT_TIMEOUT_MS = 120_000;
export const SELFTEST_TOTAL_STEPS = 15;

let _laeuft = false;

/** Fester Testinhalt — nie aus dem Request. */
function testInhalt(marker) {
  return Buffer.from(`Postbuch Selbsttest ${marker}\n${'.'.repeat(256)}\n`, 'utf8');
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Führt den Konformitätstest gegen ein Backend aus.
 *
 * @param {string} backendName
 * @param {(fortschritt:{schritt:number,gesamt:number,name:string})=>void} [onProgress]
 * @returns {Promise<{ ok:boolean, backend:string, schritte:Array, dauerMs:number }>}
 */
export async function runAdapterConformance(backendName, onProgress) {
  if (!BACKENDS.includes(backendName)) {
    throw new Error(`Unbekanntes Ablage-Backend: "${backendName}"`);
  }
  if (_laeuft) {
    const err = new Error('Es läuft bereits ein Selbsttest.');
    err.code = 'BEREITS_AKTIV';
    throw err;
  }
  _laeuft = true;

  const start = Date.now();
  const adapter = getAdapter(backendName);
  const laufId = randomUUID();
  const schritte = [];
  let wurzelId = null;
  let laufOrdnerId = null;
  let fortschritt = 0;

  const deadline = start + GESAMT_TIMEOUT_MS;
  const pruefeDeadline = () => {
    if (Date.now() > deadline) throw new Error('Zeitlimit des Selbsttests überschritten.');
  };

  /**
   * Ein Prüfschritt. `detail` darf nur enthalten, was der Test selbst erzeugt
   * hat — niemals Fremdinhalte.
   */
  async function schritt(name, fn, { sicherheitsrelevant = false } = {}) {
    pruefeDeadline();
    onProgress?.({ schritt: fortschritt, gesamt: SELFTEST_TOTAL_STEPS, name });
    const t0 = Date.now();
    try {
      const detail = await fn();
      schritte.push({ name, ok: true, dauerMs: Date.now() - t0, detail: detail ?? null, sicherheitsrelevant });
      onProgress?.({ schritt: ++fortschritt, gesamt: SELFTEST_TOTAL_STEPS, name });
      return detail;
    } catch (err) {
      schritte.push({
        name, ok: false, dauerMs: Date.now() - t0, sicherheitsrelevant,
        // clientSafeError statt roher message: der Nextcloud-Adapter markiert
        // Fehler privater Ziele mit `zielIstPrivat`, und ein .slice() auf
        // err.message wirft genau diesen Marker weg.
        detail: clientSafeError(err),
      });
      onProgress?.({ schritt: ++fortschritt, gesamt: SELFTEST_TOTAL_STEPS, name });
      return undefined;
    }
  }

  try {
    appLog('INFO', 'selbsttest', `Konformitätstest gegen "${backendName}" gestartet`);

    // ── Vorbereitung ────────────────────────────────────────────────────────
    // getAblageRoot(), nicht getRoot(): der Test muss innerhalb desselben
    // Bereichs arbeiten, gegen den der Adapter seine Wurzelprüfung fährt —
    // sonst weist er seine eigenen Testdateien zurück.
    const holeWurzel = () => (typeof adapter.getAblageRoot === 'function'
      ? adapter.getAblageRoot()
      : adapter.getRoot());

    const root = await schritt('Ablage erreichbar (Wurzel abrufen)', async () => {
      const r = await holeWurzel();
      if (!r?.id) throw new Error('Wurzel liefert keine ID.');
      return null;      // die Wurzel-ID ist eine Fremdinformation → nicht ausgeben
    });
    if (root === undefined) throw new Error('abbruch');

    const wurzel = await holeWurzel();
    const w = await adapter.findOrCreateFolder(wurzel.id, WURZEL_ORDNER, { strict: true });
    wurzelId = w.id;
    const lauf = await adapter.findOrCreateFolder(wurzelId, laufId, { strict: true });
    laufOrdnerId = lauf.id;

    // ── Ordner ──────────────────────────────────────────────────────────────
    let zielId = null;
    await schritt('Ordner anlegen', async () => {
      const r = await adapter.findOrCreateFolder(laufOrdnerId, 'Ziel', { strict: true });
      zielId = r.id;
      if (r.existed) throw new Error('Ordner galt als vorhanden, obwohl er neu ist.');
      return null;
    });

    await schritt('Ordner anlegen ist idempotent (zweiter Aufruf findet ihn)', async () => {
      const r = await adapter.findOrCreateFolder(laufOrdnerId, 'Ziel', { strict: true });
      if (!r.existed) throw new Error('Zweiter Aufruf hat einen neuen Ordner angelegt statt den vorhandenen zu finden.');
      if (r.id !== zielId) throw new Error('Zweiter Aufruf liefert eine andere Ordner-ID.');
      return null;
    });

    // ── Upload ──────────────────────────────────────────────────────────────
    const inhalt = testInhalt(laufId);
    const erwarteterHash = sha256(inhalt);
    let dateiId = null;
    let dateiName = null;

    await schritt('Datei hochladen (Umlaute und Leerzeichen im Namen)', async () => {
      const r = await adapter.uploadNew(inhalt, 'Prüfdatei März äöü.pdf', laufOrdnerId);
      if (!r?.id) throw new Error('Upload liefert keine ID.');
      if (!r.name) throw new Error('Upload liefert keinen Namen — das Interface sagt name zu.');
      dateiId = r.id;
      dateiName = r.name;
      return { name: r.name };
    });

    await schritt('Namenskollision erzeugt einen neuen Namen statt zu überschreiben', async () => {
      const r = await adapter.uploadNew(inhalt, 'Prüfdatei März äöü.pdf', laufOrdnerId);
      if (r.id === dateiId) throw new Error('Zweiter Upload hat die erste Datei überschrieben.');
      if (r.name === dateiName) {
        throw new Error(`Beide Dateien heißen "${r.name}" — Überschreibungsgefahr.`);
      }
      return { name: r.name };
    });

    // Zwei sichere Ausgänge sind zulässig, und es sind wirklich beide sicher:
    // das Backend bereinigt den Namen (Nextcloud, über sanitizeSegment) ODER es
    // lehnt ihn rundheraus ab (OneDrive antwortet mit HTTP 400). Unsicher ist
    // nur der dritte Fall — die Datei landet außerhalb des Testordners.
    await schritt(
      'Pfad-Traversal im Dateinamen wird abgewehrt',
      async () => {
        let r;
        try {
          r = await adapter.uploadNew(inhalt, '../../../postbuch-traversal.pdf', laufOrdnerId);
        } catch {
          return { abwehr: 'vom Backend abgelehnt' };
        }
        const meta = await adapter.getMeta(r.id);
        if (meta.parentId !== laufOrdnerId) {
          throw new Error('Die Datei wurde AUSSERHALB des Testordners abgelegt.');
        }
        if (/[/\\]/.test(meta.name) || meta.name.includes('..')) {
          throw new Error(`Der Dateiname wurde nicht bereinigt: "${meta.name}"`);
        }
        return { abwehr: 'Name bereinigt', name: meta.name };
      },
      { sicherheitsrelevant: true },
    );

    // ── Lesen ───────────────────────────────────────────────────────────────
    await schritt('Metadaten abrufen', async () => {
      const m = await adapter.getMeta(dateiId);
      if (m.isFolder) throw new Error('Datei wird als Ordner gemeldet.');
      if (m.parentId !== laufOrdnerId) throw new Error('Falscher Elternordner gemeldet.');
      if (m.size !== inhalt.length) throw new Error(`Größe weicht ab: ${m.size} statt ${inhalt.length}.`);
      if (m.lastModified && Number.isNaN(new Date(m.lastModified).getTime())) {
        throw new Error('lastModified ist kein gültiger Zeitstempel.');
      }
      return { groesse: m.size, mitPruefsumme: !!m.sha256 };
    });

    await schritt('Herunterladen liefert exakt denselben Inhalt (sha256)', async () => {
      const buf = await adapter.download(dateiId);
      if (sha256(buf) !== erwarteterHash) throw new Error('Die heruntergeladene Datei weicht vom Original ab.');
      return { bytes: buf.length };
    });

    await schritt('Pfad zur Datei auflösen', async () => {
      const p = await adapter.getPath(dateiId);
      if (typeof p !== 'string' || !p) throw new Error('getPath liefert keinen Pfad.');
      // Nur die Endung ausgeben — der volle Pfad ist eine Ortsinformation.
      return { endetAufDateiname: p.endsWith(dateiName) };
    });

    // ── Verschieben ─────────────────────────────────────────────────────────
    await schritt('In Zielordner verschieben', async () => {
      const vorherigeId = dateiId;
      const r = await adapter.move(dateiId, zielId, 'Verschoben P000000.pdf');
      if (!r?.id) throw new Error('move liefert keine ID.');
      if (!r.name) throw new Error('move liefert keinen Namen — das Interface sagt name zu.');
      const m = await adapter.getMeta(r.id);
      if (m.parentId !== zielId) throw new Error('Die Datei liegt nach dem Verschieben nicht im Zielordner.');
      dateiId = r.id;
      // Nur Information, kein Fehlerfall: OneDrive und Nextcloud behalten die
      // ID beim Verschieben, ein künftiges Backend darf sie auch wechseln —
      // der Aufrufer nimmt ohnehin die zurückgegebene ID.
      return { name: r.name, idStabil: r.id === vorherigeId };
    });

    await schritt('Datei nach dem Verschieben weiterhin über ihre ID auffindbar', async () => {
      const buf = await adapter.download(dateiId);
      if (sha256(buf) !== erwarteterHash) throw new Error('Inhalt nach dem Verschieben verändert.');
      return null;
    });

    // ── Auflistung ──────────────────────────────────────────────────────────
    await schritt('Ordnerinhalt auflisten', async () => {
      const kinder = await adapter.listChildren(zielId);
      if (!kinder.some((k) => k.id === dateiId)) throw new Error('Die verschobene Datei fehlt in der Auflistung.');
      return { anzahl: kinder.length };
    });

    await schritt('Rekursive Auflistung findet alle Testdateien', async () => {
      const alle = await adapter.listAllFilesRecursive(laufOrdnerId);
      if (!alle.some((f) => f.id === dateiId)) throw new Error('Die verschobene Datei fehlt in der rekursiven Auflistung.');
      return { anzahl: alle.length };
    });

    // ── Inhalt ersetzen ─────────────────────────────────────────────────────
    await schritt('Inhalt einer bestehenden Datei ersetzen', async () => {
      const neu = testInhalt(`${laufId}-v2`);
      await adapter.uploadContent(dateiId, neu);
      const buf = await adapter.download(dateiId);
      if (sha256(buf) !== sha256(neu)) throw new Error('Der ersetzte Inhalt kam nicht an.');
      return null;
    });

    // ── Löschen ─────────────────────────────────────────────────────────────
    await schritt('Datei löschen', async () => {
      await adapter.remove(dateiId);
      try {
        await adapter.getMeta(dateiId);
      } catch {
        return null;   // erwartet: nicht mehr auffindbar
      }
      throw new Error('Die Datei ist nach dem Löschen noch abrufbar.');
    });
  } catch (err) {
    if (String(err?.message) !== 'abbruch') {
      schritte.push({
        name: 'Unerwarteter Abbruch', ok: false, dauerMs: 0,
        detail: clientSafeError(err), sicherheitsrelevant: false,
      });
    }
  } finally {
    // Aufräumen IMMER — und ausschließlich innerhalb der eigenen UUID.
    try {
      if (laufOrdnerId) {
        const reste = await adapter.listAllFilesRecursive(laufOrdnerId).catch(() => []);
        for (const f of reste) await adapter.remove(f.id).catch(() => {});
        await adapter.remove(laufOrdnerId).catch(() => {});
      }
      // Auch die Hülle wegräumen — aber nur, wenn sie wirklich leer ist. Läuft
      // parallel noch ein anderer Lauf (oder liegt dort etwas Fremdes), bleibt
      // sie stehen; ein Selbsttest löscht nichts, was er nicht angelegt hat.
      if (wurzelId) {
        const uebrig = await adapter.listChildren(wurzelId).catch(() => [null]);
        if (uebrig.length === 0) await adapter.remove(wurzelId).catch(() => {});
      }
    } catch { /* Aufräumfehler dürfen das Ergebnis nicht kippen */ }
    _laeuft = false;
  }

  const ok = schritte.length > 0 && schritte.every((s) => s.ok);
  const dauerMs = Date.now() - start;
  appLog(ok ? 'INFO' : 'WARN', 'selbsttest',
    `Konformitätstest "${backendName}": ${schritte.filter((s) => s.ok).length}/${schritte.length} bestanden (${dauerMs} ms)`);

  return { ok, backend: backendName, schritte, dauerMs };
}

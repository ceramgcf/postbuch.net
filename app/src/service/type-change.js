/** Manuelle, zweiachsige LxD-Korrektur mit derselben Aktivierungslogik wie der Inserter. */
import pool from '../db.js';
import { effektiveGruppe } from '../lib/taxonomie.js';
import { verschiebeAnSollort } from './ablage-sollort.js';
import { uiLog } from '../log.js';
import { appLog } from '../app-log.js';

export async function isCompatible(oldL, oldD, newL, newD) {
  const [alt, neu] = await Promise.all([
    effektiveGruppe(oldL, oldD), effektiveGruppe(newL, newD),
  ]);
  // Generisch → Spezial braucht die fehlenden Extraktionsfelder; Spezial →
  // generisch bewahrt Detaildaten bewusst. Zwischen Spezialfamilien ist ein
  // Reprocess nötig, innerhalb derselben Familie nicht.
  return !(alt === 'generisch' && neu !== 'generisch')
    && !(alt !== 'generisch' && neu !== 'generisch' && alt !== neu);
}

export async function applyCompatibleChange(postid, oldL, oldD, newL, newD) {
  if (!(await isCompatible(oldL, oldD, newL, newD))) {
    throw new Error('applyCompatibleChange: LxD-Wechsel braucht Wiederverarbeitung');
  }
  const client = await pool.connect();
  let docRow;
  try {
    await client.query('BEGIN');
    const r = await client.query(`SELECT storage_id, storage_backend, metadata
      FROM postbuch.postbuch WHERE postid=$1 FOR UPDATE`, [postid]);
    if (!r.rows[0]) throw new Error(`Dokument ${postid} nicht gefunden`);
    docRow = r.rows[0];
    await client.query(`UPDATE postbuch.postbuch SET art=$1, lebensbereich=$2,
      dokumentart=$1 WHERE postid=$3`, [newD, newL, postid]);
    if (docRow.metadata) {
      const metadata = typeof docRow.metadata === 'string' ? JSON.parse(docRow.metadata) : docRow.metadata;
      const root = Array.isArray(metadata) ? metadata[0] : metadata;
      if (root && typeof root === 'object') {
        // Nur aktualisieren, wenn die Schlüssel bereits vorhanden waren – sonst würde ein
        // Undo (erneuter Aufruf mit vertauschtem L/D) Schlüssel dauerhaft hinterlassen,
        // die vor dem allerersten Wechsel gar nicht existierten.
        if ('lebensbereich' in root) root.lebensbereich = newL;
        if ('dokumentart' in root) root.dokumentart = newD;
        delete root.dokumentTyp;
        await client.query('UPDATE postbuch.postbuch SET metadata=$1::jsonb WHERE postid=$2',
          [JSON.stringify(Array.isArray(metadata) ? [root, ...metadata.slice(1)] : root), postid]);
      }
    }
    const [oldGroup, newGroup] = await Promise.all([
      effektiveGruppe(oldL, oldD),
      effektiveGruppe(newL, newD),
    ]);
    if (oldGroup === 'arztrechnung' && newGroup === 'arztrechnung' && oldD !== newD) {
      await client.query('UPDATE postbuch.arztrechnung SET typ=$1 WHERE postid=$2', [newD, postid]);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally { client.release(); }

  let moved = false; let newWebUrl = null;
  if (docRow.storage_id) {
    try {
      ({ moved, newWebUrl } = await verschiebeAnSollort(postid));
    } catch (err) {
      appLog('ERROR', 'type-change', `Ablage-Umzug ${postid} fehlgeschlagen: ${err.message}`, { entity: 'postbuch', entityId: postid });
    }
  }
  uiLog('UPDATE', 'postbuch', postid, `LxD-Änderung: ${oldL}/${oldD} → ${newL}/${newD}`);
  return { moved, newWebUrl };
}

export function buildReprocessInstruction(oldL, oldD, newL, newD) {
  return `Klassifiziere dieses Dokument zwingend als lebensbereich="${newL}" und dokumentart="${newD}" (vorher ${oldL}/${oldD}). `
    + 'Fülle exakt den für diese LxD-Zelle vorgesehenen Datenblock; unpassende Spezialblöcke entfallen.';
}

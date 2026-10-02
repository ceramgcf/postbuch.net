/**
 * service/akten-service.js — Single Source of Truth für schreibende Akten-Operationen.
 *
 * Sowohl die HTTP-Routes (routes/akten.js) als auch der Chat-Assistent
 * (service/chat-agent.js + routes/chat.js) mutieren Akten ausschließlich über
 * dieses Modul — es gibt keinen zweiten Implementierungsstrang.
 *
 * Kernstück ist `runAkteOp(op, db)`: ein Dispatcher über **symmetrische**
 * Operationen. Jede Operation gibt neben ihrem Ergebnis eine `undo`-Operation
 * zurück, die ihrerseits wieder eine gültige Operation für `runAkteOp` ist.
 * Dadurch funktioniert derselbe Executor für Ausführung, Bestätigung (pending →
 * done) und Rückgängig (done → undone) — siehe routes/chat.js confirm/undo.
 *
 * `db` ist eine query-Funktion (text, params) => Promise. Default ist der Pool;
 * für transaktionale Batches (confirm/undo) wird ein Client-gebundenes query
 * via `withTransaction()` übergeben.
 */

import { query as poolQuery, getClient } from '../db.js';
import { uiLog } from '../log.js';
import { loadDynamicSettings } from '../config.js';
import { regenerateEmbedding, embedText } from '../lib/embedding.js';

export const AKTEID_RE = /^A\d{6}$/;
export const POSTID_RE = /^P\d{6}$/;

// Fehler mit HTTP-Status + maschinenlesbarem Code. Routes mappen auf res.status;
// Chat-Tools fangen ab und geben { error: message } an das LLM zurück.
export class AkteServiceError extends Error {
  constructor(message, status = 400, code = 'bad_request') {
    super(message);
    this.name = 'AkteServiceError';
    this.status = status;
    this.code = code;
  }
}

// ── Embedding-Berechnung (aus routes/akten.js hierher verlagert) ──────────────

// Berechnet & persistiert das Akte-Embedding (betreff + beschreibung + Betreffe
// der zugeordneten Dokumente) — fire-and-forget, wirft nie an den Aufrufer.
// Der Embedding-Aufruf selbst läuft über den einzigen Pfad (lib/embedding.js).
export async function computeAndSaveAkteEmbedding(akteid) {
  let settingsSnapshot = null;
  try { settingsSnapshot = await loadDynamicSettings(); } catch {}
  try {
    const [akteResult, dokResult] = await Promise.all([
      poolQuery(`SELECT betreff, beschreibung FROM akte WHERE akteid = $1`, [akteid]),
      poolQuery(`SELECT p.betreff FROM akte_dokument ad JOIN postbuch p ON p.postid = ad.postid WHERE ad.akteid = $1`, [akteid]),
    ]);
    if (akteResult.rows.length === 0) return;
    const { betreff, beschreibung } = akteResult.rows[0];
    const textParts = [
      betreff,
      beschreibung,
      ...dokResult.rows.map(d => d.betreff).filter(Boolean),
    ].filter(Boolean);
    if (textParts.length === 0) return;

    const erg = await embedText(textParts.join(' | '), settingsSnapshot, {
      entity: 'akte', entityId: akteid,
    });
    if (!erg) return;
    await poolQuery(
      `UPDATE akte SET embedding = $1::halfvec, embedding_signature = $2 WHERE akteid = $3`,
      [erg.literal, erg.signature, akteid],
    );
    uiLog('AI_EMBEDDING', 'akte', akteid, `${erg.signature} updated`);
  } catch (err) {
    console.error('computeAndSaveAkteEmbedding failed:', err);
  }
}

const AKTE_EMBEDDING_DEBOUNCE_MS = 30 * 1000;
const akteEmbeddingTimers = new Map();

export function scheduleAkteEmbedding(akteid) {
  if (akteEmbeddingTimers.has(akteid)) clearTimeout(akteEmbeddingTimers.get(akteid));
  const timer = setTimeout(() => {
    akteEmbeddingTimers.delete(akteid);
    computeAndSaveAkteEmbedding(akteid).catch(err => console.error('Scheduled akte embedding failed:', err));
  }, AKTE_EMBEDDING_DEBOUNCE_MS);
  akteEmbeddingTimers.set(akteid, timer);
}

export function getAkteEmbeddingQueue() {
  const akteidList = Array.from(akteEmbeddingTimers.keys());
  return { count: akteidList.length, akteidList };
}

// Dokument-Embedding nach Schlagwort-/Notiz-Änderung neu berechnen (fire-and-forget).
function schedulePostbuchEmbedding(postid) {
  regenerateEmbedding(postid)
    .then(() => uiLog('AI_EMBEDDING', 'postbuch', postid, 'Embedding aktualisiert'))
    .catch(err => console.error('Scheduled postbuch embedding failed:', err));
}

// ── Transaktions-Helper ───────────────────────────────────────────────────────

export async function withTransaction(fn) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await fn((text, params) => client.query(text, params));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* Verbindung ggf. tot */ }
    throw err;
  } finally {
    client.release();
  }
}

// ── Helfer ────────────────────────────────────────────────────────────────────

async function assertAkteExists(akteid, db) {
  if (!AKTEID_RE.test(akteid)) throw new AkteServiceError('Ungültige AkteID', 400, 'bad_akteid');
  const r = await db(`SELECT akteid FROM akte WHERE akteid = $1`, [akteid]);
  if (r.rows.length === 0) throw new AkteServiceError(`Akte ${akteid} nicht gefunden`, 404, 'akte_not_found');
}

async function assertPostExists(postid, db) {
  if (!POSTID_RE.test(postid)) throw new AkteServiceError('Ungültige PostID', 400, 'bad_postid');
  const r = await db(`SELECT postid FROM postbuch WHERE postid = $1`, [postid]);
  if (r.rows.length === 0) throw new AkteServiceError(`Dokument ${postid} nicht gefunden`, 404, 'post_not_found');
}

const AKTE_META_FIELDS = ['betreff', 'beschreibung', 'schlagwoerter', 'notiz', 'historisch', 'dok_sort_mode'];

// ── Zentraler Operations-Dispatcher ───────────────────────────────────────────

/**
 * Führt eine einzelne Akten-Operation aus und liefert { result, undo, description }.
 * `undo` ist selbst eine gültige Operation → derselbe Executor kann sie später
 * rückgängig machen. `db` = query-Funktion (Pool oder Transaktions-Client).
 */
export async function runAkteOp(op, db = poolQuery) {
  switch (op.type) {

    case 'create_akte': {
      const betreff = (op.betreff || '').trim();
      if (!betreff) throw new AkteServiceError('Betreff ist erforderlich', 400, 'betreff_required');
      const schlagwoerter = Array.isArray(op.schlagwoerter) && op.schlagwoerter.length ? op.schlagwoerter : null;
      const r = await db(
        `INSERT INTO akte (betreff, beschreibung, schlagwoerter)
         VALUES ($1, $2, $3::text[]) RETURNING *`,
        [betreff, op.beschreibung || null, schlagwoerter],
      );
      const row = r.rows[0];
      uiLog('CREATE', 'akte', row.akteid, `betreff: ${betreff.slice(0, 80)}`);
      return {
        result: row,
        undo: { type: 'delete_akte', akteid: row.akteid },
        description: `Akte ${row.akteid} „${betreff.slice(0, 60)}" angelegt`,
      };
    }

    case 'update_akte_metadata': {
      await assertAkteExists(op.akteid, db);
      const patch = op.patch || {};
      const keys = Object.keys(patch).filter(k => AKTE_META_FIELDS.includes(k));
      if (keys.length === 0) throw new AkteServiceError('Keine aktualisierbaren Felder angegeben', 400, 'no_fields');

      // Vorher-Zustand für Undo einsammeln (nur die geänderten Felder)
      const beforeR = await db(`SELECT ${keys.join(', ')} FROM akte WHERE akteid = $1`, [op.akteid]);
      const before = {};
      for (const k of keys) before[k] = beforeR.rows[0][k];

      const sets = [];
      const params = [];
      let i = 1;
      for (const k of keys) {
        sets.push(k === 'schlagwoerter' ? `${k} = $${i}::text[]` : `${k} = $${i}`);
        params.push(patch[k]);
        i++;
      }
      params.push(op.akteid);
      const r = await db(`UPDATE akte SET ${sets.join(', ')} WHERE akteid = $${i} RETURNING *`, params);
      uiLog('UPDATE', 'akte', op.akteid, `fields: ${keys.join(', ')}`);
      if ('betreff' in patch || 'beschreibung' in patch) scheduleAkteEmbedding(op.akteid);
      return {
        result: r.rows[0],
        undo: { type: 'update_akte_metadata', akteid: op.akteid, patch: before },
        description: `Metadaten von Akte ${op.akteid} geändert (${keys.join(', ')})`,
      };
    }

    case 'delete_akte': {
      // Snapshot vor dem Löschen (für Undo). Cascade löscht akte_dokument-Links mit.
      const akteR = await db(`SELECT * FROM akte WHERE akteid = $1`, [op.akteid]);
      if (akteR.rows.length === 0) throw new AkteServiceError(`Akte ${op.akteid} nicht gefunden`, 404, 'akte_not_found');
      const dokR = await db(`SELECT postid, sort_order, added_at FROM akte_dokument WHERE akteid = $1 ORDER BY sort_order ASC`, [op.akteid]);
      const snapshot = { akte: akteR.rows[0], dokumente: dokR.rows };
      delete snapshot.akte.embedding; // Vektor nicht mitschleppen — wird neu berechnet
      await db(`DELETE FROM akte WHERE akteid = $1`, [op.akteid]);
      uiLog('DELETE', 'akte', op.akteid, 'akte gelöscht');
      return {
        result: { akteid: op.akteid },
        undo: { type: 'restore_akte', snapshot },
        description: `Akte ${op.akteid} „${(snapshot.akte.betreff || '').slice(0, 60)}" gelöscht (${dokR.rows.length} Zuordnungen)`,
      };
    }

    case 'restore_akte': {
      const { akte, dokumente } = op.snapshot || {};
      if (!akte?.akteid) throw new AkteServiceError('Ungültige Snapshot-Daten', 400, 'bad_snapshot');
      await db(`
        INSERT INTO akte (akteid, betreff, beschreibung, schlagwoerter, notiz, historisch, dok_sort_mode, created_at, updated_at)
        VALUES ($1, $2, $3, $4::text[], $5, $6, $7, $8, $9)
        ON CONFLICT (akteid) DO NOTHING
      `, [akte.akteid, akte.betreff, akte.beschreibung, akte.schlagwoerter, akte.notiz,
          akte.historisch ?? false, akte.dok_sort_mode ?? 'custom', akte.created_at, akte.updated_at]);
      for (const dok of (Array.isArray(dokumente) ? dokumente : [])) {
        await db(`
          INSERT INTO akte_dokument (akteid, postid, sort_order, added_at)
          VALUES ($1, $2, $3, COALESCE($4, now()))
          ON CONFLICT (akteid, postid) DO NOTHING
        `, [akte.akteid, dok.postid, dok.sort_order ?? 0, dok.added_at ?? null]);
      }
      uiLog('RESTORE', 'akte', akte.akteid, 'akte wiederhergestellt');
      scheduleAkteEmbedding(akte.akteid);
      return {
        result: { akteid: akte.akteid },
        undo: { type: 'delete_akte', akteid: akte.akteid },
        description: `Akte ${akte.akteid} wiederhergestellt`,
      };
    }

    case 'add_document': {
      await assertAkteExists(op.akteid, db);
      await assertPostExists(op.postid, db);
      const maxR = await db(
        `SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM akte_dokument WHERE akteid = $1`,
        [op.akteid],
      );
      const nextOrder = maxR.rows[0].next_order;
      const r = await db(`
        INSERT INTO akte_dokument (akteid, postid, sort_order)
        VALUES ($1, $2, $3)
        ON CONFLICT (akteid, postid) DO NOTHING
        RETURNING *
      `, [op.akteid, op.postid, nextOrder]);
      if (r.rows.length === 0) {
        // Bereits verknüpft — kein No-Op-Undo nötig
        return {
          result: { akteid: op.akteid, postid: op.postid, alreadyLinked: true },
          undo: null,
          description: `Dokument ${op.postid} war bereits in Akte ${op.akteid}`,
        };
      }
      uiLog('CREATE', 'akte_dokument', op.akteid, `postid ${op.postid} hinzugefügt`);
      scheduleAkteEmbedding(op.akteid);
      return {
        result: { ...r.rows[0], alreadyLinked: false },
        undo: { type: 'remove_document', akteid: op.akteid, postid: op.postid },
        description: `Dokument ${op.postid} zu Akte ${op.akteid} hinzugefügt`,
      };
    }

    case 'remove_document': {
      if (!AKTEID_RE.test(op.akteid)) throw new AkteServiceError('Ungültige AkteID', 400, 'bad_akteid');
      if (!POSTID_RE.test(op.postid)) throw new AkteServiceError('Ungültige PostID', 400, 'bad_postid');
      const r = await db(
        `DELETE FROM akte_dokument WHERE akteid = $1 AND postid = $2 RETURNING sort_order, added_at`,
        [op.akteid, op.postid],
      );
      if (r.rows.length === 0) throw new AkteServiceError('Verknüpfung nicht gefunden', 404, 'link_not_found');
      uiLog('DELETE', 'akte_dokument', op.akteid, `postid ${op.postid} entfernt`);
      scheduleAkteEmbedding(op.akteid);
      return {
        result: { akteid: op.akteid, postid: op.postid },
        undo: { type: 'add_document_at', akteid: op.akteid, postid: op.postid, sort_order: r.rows[0].sort_order, added_at: r.rows[0].added_at },
        description: `Dokument ${op.postid} aus Akte ${op.akteid} entfernt`,
      };
    }

    // Wie add_document, aber mit vorgegebener sort_order/added_at (Undo von remove_document)
    case 'add_document_at': {
      await db(`
        INSERT INTO akte_dokument (akteid, postid, sort_order, added_at)
        VALUES ($1, $2, $3, COALESCE($4, now()))
        ON CONFLICT (akteid, postid) DO NOTHING
      `, [op.akteid, op.postid, op.sort_order ?? 0, op.added_at ?? null]);
      uiLog('CREATE', 'akte_dokument', op.akteid, `postid ${op.postid} wiederhergestellt`);
      scheduleAkteEmbedding(op.akteid);
      return {
        result: { akteid: op.akteid, postid: op.postid },
        undo: { type: 'remove_document', akteid: op.akteid, postid: op.postid },
        description: `Dokument ${op.postid} in Akte ${op.akteid} wiederhergestellt`,
      };
    }

    case 'reorder_documents': {
      await assertAkteExists(op.akteid, db);
      const order = op.order;
      if (!Array.isArray(order) || order.length === 0) throw new AkteServiceError('Reihenfolge muss ein Array von PostIDs sein', 400, 'bad_order');
      for (const postid of order) {
        if (!POSTID_RE.test(postid)) throw new AkteServiceError(`Ungültige PostID: ${postid}`, 400, 'bad_postid');
      }
      // Vorher-Reihenfolge für Undo
      const beforeR = await db(`SELECT postid FROM akte_dokument WHERE akteid = $1 ORDER BY sort_order ASC, added_at ASC`, [op.akteid]);
      const beforeOrder = beforeR.rows.map(r => r.postid);
      await db(`
        UPDATE akte_dokument ad
        SET sort_order = t.new_order
        FROM (
          SELECT unnest($1::text[]) AS postid, generate_series(0, $2::int) AS new_order
        ) t
        WHERE ad.akteid = $3 AND ad.postid = t.postid
      `, [order, order.length - 1, op.akteid]);
      uiLog('UPDATE', 'akte_dokument_order', op.akteid, `${order.length} docs reordered`);
      return {
        result: { akteid: op.akteid },
        undo: { type: 'reorder_documents', akteid: op.akteid, order: beforeOrder },
        description: `Dokumente in Akte ${op.akteid} neu sortiert`,
      };
    }

    case 'set_historisch': {
      await assertAkteExists(op.akteid, db);
      if (typeof op.historisch !== 'boolean') throw new AkteServiceError('historisch (boolean) erforderlich', 400, 'bad_historisch');
      const beforeAkteR = await db(`SELECT historisch FROM akte WHERE akteid = $1`, [op.akteid]);
      const beforeAkte = beforeAkteR.rows[0].historisch;
      await db(`UPDATE akte SET historisch = $1 WHERE akteid = $2`, [op.historisch, op.akteid]);

      let changedDocs = [];
      if (op.auch_dokumente === true) {
        const changedR = await db(
          `UPDATE postbuch SET historisch = $1
           FROM akte_dokument ad
           WHERE postbuch.postid = ad.postid AND ad.akteid = $2 AND postbuch.historisch != $1
           RETURNING postbuch.postid`,
          [op.historisch, op.akteid],
        );
        changedDocs = changedR.rows.map(r => ({ postid: r.postid, historisch: !op.historisch }));
      }
      uiLog('UPDATE', 'akte', op.akteid, `historisch=${op.historisch}, dokumente_geaendert=${changedDocs.length}`);
      return {
        result: { akteid: op.akteid, historisch: op.historisch, dokumente_geaendert: changedDocs.length },
        undo: { type: 'restore_historisch', akteid: op.akteid, akte_historisch: beforeAkte, docs: changedDocs },
        description: `Akte ${op.akteid} ${op.historisch ? 'archiviert' : 'aus Archiv geholt'}${changedDocs.length ? ` (+${changedDocs.length} Dokumente)` : ''}`,
      };
    }

    case 'restore_historisch': {
      await db(`UPDATE akte SET historisch = $1 WHERE akteid = $2`, [op.akte_historisch, op.akteid]);
      for (const d of (Array.isArray(op.docs) ? op.docs : [])) {
        await db(`UPDATE postbuch SET historisch = $1 WHERE postid = $2`, [d.historisch, d.postid]);
      }
      uiLog('UPDATE', 'akte', op.akteid, `historisch zurückgesetzt`);
      return {
        result: { akteid: op.akteid },
        undo: null,
        description: `Archivstatus von Akte ${op.akteid} zurückgesetzt`,
      };
    }

    case 'update_document_metadata': {
      await assertPostExists(op.postid, db);
      const patch = op.patch || {};
      const allowed = ['schlagwoerter', 'notiz'];
      const keys = Object.keys(patch).filter(k => allowed.includes(k));
      if (keys.length === 0) throw new AkteServiceError('Nur schlagwoerter und notiz sind änderbar', 400, 'no_fields');
      const beforeR = await db(`SELECT ${keys.join(', ')} FROM postbuch WHERE postid = $1`, [op.postid]);
      const before = {};
      for (const k of keys) before[k] = beforeR.rows[0][k];

      const sets = [];
      const params = [];
      let i = 1;
      for (const k of keys) {
        sets.push(k === 'schlagwoerter' ? `${k} = $${i}::text[]` : `${k} = $${i}`);
        params.push(patch[k]);
        i++;
      }
      params.push(op.postid);
      await db(`UPDATE postbuch SET ${sets.join(', ')} WHERE postid = $${i}`, params);
      uiLog('UPDATE', 'postbuch', op.postid, `fields: ${keys.join(', ')}`);
      if ('schlagwoerter' in patch) schedulePostbuchEmbedding(op.postid);
      return {
        result: { postid: op.postid },
        undo: { type: 'update_document_metadata', postid: op.postid, patch: before },
        description: `Dokument ${op.postid}: ${keys.join(', ')} geändert`,
      };
    }

    default:
      throw new AkteServiceError(`Unbekannte Operation: ${op.type}`, 400, 'unknown_op');
  }
}

// ── Read-Helfer (für Chat-Lese-Tools) ─────────────────────────────────────────

// Akte + zugeordnete Dokumente (kompakt) — für get_akte / Vollständigkeitsprüfung.
export async function getAkteWithDocuments(akteid, db = poolQuery) {
  if (!AKTEID_RE.test(akteid)) throw new AkteServiceError('Ungültige AkteID', 400, 'bad_akteid');
  const akteR = await db(`SELECT akteid, betreff, beschreibung, schlagwoerter, notiz, historisch, created_at, updated_at FROM akte WHERE akteid = $1`, [akteid]);
  if (akteR.rows.length === 0) throw new AkteServiceError(`Akte ${akteid} nicht gefunden`, 404, 'akte_not_found');
  const dokR = await db(`
    SELECT ad.sort_order, p.postid, p.briefdatum, p.dokumentart AS art, p.betreff, p.kontakt,
           p.familienmitglied, p.richtung::text AS richtung, p.schlagwoerter
    FROM akte_dokument ad
    JOIN postbuch p ON p.postid = ad.postid
    WHERE ad.akteid = $1
    ORDER BY ad.sort_order ASC, ad.added_at ASC
  `, [akteid]);
  return { akte: akteR.rows[0], dokumente: dokR.rows };
}

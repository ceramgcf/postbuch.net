/**
 * service/resolve-duplicate.js — Gemeinsamer Handler für Duplikat-Entscheidungen
 *
 * Wird aufgerufen von:
 *   - routes/actions.js (manuell via UI / Magic-Link)
 *   - duplicate-timeout-job.js (automatisch nach Ablauf)
 *   - discord-gateway.js (Bot-Button-Klick, via setButtonHandler)
 *
 * @param {object}  params
 * @param {string}  params.jobId      - UUID des suspendierten Jobs
 * @param {'replace'|'discard'|'keep_both'} params.decision
 * @param {string}  [params.source]   - Ursprung der Entscheidung (z.B. 'ui', 'discord', 'timeout')
 * @param {object}  [params.settings] - Optional vorgeladene Settings
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */

import * as suspensionStore from './suspension-store.js';
import * as discord from '../lib/discord.js';
import { getAdapter } from '../lib/storage/index.js';
import { recordOrphanedFailed } from './failed-handler.js';
import * as tracker from '../jobs/tracker.js';
import { enqueueDocument } from '../jobs/pipeline-queue.js';
import { loadDynamicSettings } from '../config.js';
import { appLog } from '../app-log.js';
import { sendPushToAllUsers } from '../lib/webpush.js';

export async function resolveDuplicate({ jobId, decision, source = 'unknown' }, settings = null) {
  const s = settings || await loadDynamicSettings();

  if (!['replace', 'discard', 'keep_both'].includes(decision)) {
    return { ok: false, reason: 'Unbekannte Entscheidung' };
  }
  // Übernahme: Die Zeile wird gelöscht und zurückgegeben. Entscheiden Benutzer
  // und Timeout-Job gleichzeitig, löst genau einer auf.
  const suspension = await suspensionStore.uebernimm(jobId);
  if (!suspension) {
    return { ok: false, reason: 'Suspension nicht gefunden (evtl. bereits entschieden)' };
  }

  const { storage_id, storage_backend, discord_message_id, payload, step_offset, reserved_postid, match_postid, match_weburl } = suspension;

  try {
    if (decision === 'discard') {
      // ─ Neues Dokument → Papierkorb, Job als erledigt markieren ─
      const trashed = await getAdapter(storage_backend)
        .moveToTrash(storage_id, `Duplikat_${reserved_postid}_${Date.now()}.pdf`).catch(async err => {
        console.warn(`[resolve-duplicate] moveToTrash fehlgeschlagen (${storage_id}): ${err.message}`);
        // Die Entscheidung ist gefallen, die Datei liegt aber noch in der
        // Ablage: als Fehleintrag sichtbar halten, statt sie still liegen zu lassen.
        await recordOrphanedFailed({
          onedriveFileId: storage_id,
          reason: 'Verworfenes Duplikat: Papierkorb-Move fehlgeschlagen',
          detail: err.message,
          sourceJobId: jobId,
          backend: storage_backend,
        }).catch(e => console.error(`[resolve-duplicate] Fehleintrag für ${storage_id} nicht angelegt: ${e.message}`));
        return null;
      });
      const trashUrl = trashed?.webUrl || null;

      tracker.complete(jobId);

      await _updateDiscordMessage(discord_message_id, s);
      await _postFollowup(decision, source, reserved_postid, match_postid, null, trashUrl, s);

      appLog('INFO', 'duplicate', `Job ${jobId}: verworfen (${source})`);
      return { ok: true };
    }

    // ─ 'replace' oder 'keep_both' → Pipeline wiederaufnehmen ─
    let embedding = null;
    if (suspension.embedding) {
      // Embedding liegt als Objekt aus der DB vor — in number[] umwandeln falls nötig
      if (Array.isArray(suspension.embedding)) {
        embedding = suspension.embedding;
      } else if (typeof suspension.embedding === 'string') {
        embedding = suspension.embedding.replace(/[[\]]/g, '').split(',').map(Number);
      }
    }

    // storage_id aus der Suspension-Tabelle ist autoritativ — der gespeicherte
    // payload kann (bei Scanner-Jobs vor dem suspPayload-Fix) ein undefiniertes
    // onedriveFileId enthalten.
    const resumedInput = {
      ...payload,
      onedriveFileId: storage_id,
      // Die suspendierte Datei liegt im Backend der Suspension, nicht
      // zwangsläufig im aktiven.
      storageBackend: storage_backend,
      _resume: {
        decision,
        reservedPostid: reserved_postid,
        matchPostid: match_postid,
        matchWeburl: match_weburl,
        embedding,
        // Signatur mitführen: ein Modellwechsel während der Suspension darf den
        // alten Vektor nicht als aktuellen ausgeben.
        embeddingSignature: suspension.embedding_signature ?? null,
      },
    };

    const stepOffsetResume = step_offset; // Phase-Offset wie beim ursprünglichen Suspend

    await tracker.resume(jobId);
    enqueueDocument(resumedInput, jobId, stepOffsetResume);

    await _updateDiscordMessage(discord_message_id, s);
    await _postFollowup(decision, source, reserved_postid, match_postid, match_weburl, null, s);

    appLog('INFO', 'duplicate', `Job ${jobId}: ${decision} (${source}) — Wiederaufnahme eingereiht`);
    return { ok: true };
  } catch (err) {
    console.error('[resolve-duplicate] Fehler bei Job %s:', jobId, err.message);
    appLog('ERROR', 'duplicate', `resolve-duplicate Job ${jobId}: ${err.message}`);
    // Die Suspension ist bereits übernommen. Kam die Wiederaufnahme nicht
    // zustande, bleibt die Datei als Fehleintrag sichtbar.
    if (decision !== 'discard' && !tracker.isActive(jobId)) {
      await recordOrphanedFailed({
        onedriveFileId: storage_id,
        reason: 'Duplikat-Entscheidung: Wiederaufnahme fehlgeschlagen',
        detail: err.message,
        sourceJobId: jobId,
        backend: storage_backend,
      }).catch(() => {});
    }
    return { ok: false, reason: err.message };
  }
}

async function _updateDiscordMessage(messageId, s) {
  if (!messageId) return;
  try {
    await discord.editMessage(messageId, { content: '— erledigt —', removeComponents: true }, s);
  } catch (err) {
    console.warn(`[resolve-duplicate] Discord editMessage fehlgeschlagen: ${err.message}`);
  }
}

async function _postFollowup(decision, source, reservedPostid, matchPostid, matchWeburl, trashUrl, s) {
  const isTimeout = (source || '').startsWith('timeout');
  let msg;
  if (decision === 'discard') {
    const trashLink = trashUrl ? ` · [Im Trash öffnen](${trashUrl})` : '';
    msg = `🗑️ Alte Fassung behalten – neue PDF \`${reservedPostid}\` verworfen${trashLink} · Bestand: \`${matchPostid}\``;
  } else if (decision === 'replace') {
    const entryLink = matchWeburl ? ` [Eintrag öffnen](${matchWeburl})` : '';
    msg = `✅ Neue Fassung behalten – ersetzt \`${matchPostid}\`.${entryLink}`;
  } else if (decision === 'keep_both') {
    msg = isTimeout
      ? `📋 Frist abgelaufen – beide Dokumente werden behalten, neuer Eintrag parallel zu \`${matchPostid}\``
      : `📋 Beide behalten – neuer Eintrag entsteht parallel zu \`${matchPostid}\``;
  } else {
    return;
  }
  try {
    await discord.sendMessage(msg, s);
  } catch (err) {
    console.warn(`[resolve-duplicate] Discord Folgenachricht fehlgeschlagen: ${err.message}`);
  }

  // Push-Benachrichtigung (fire-and-forget)
  const appHost = (s?.app_host || '').replace(/\/$/, '');
  let pushTitle, pushBody, pushUrl;
  if (decision === 'discard') {
    pushTitle = '🗑️ Alte Fassung behalten';
    pushBody  = `Neue PDF verworfen, Bestand: ${matchPostid}`;
    pushUrl   = appHost ? `${appHost}/logs` : '/logs';
  } else if (decision === 'replace') {
    pushTitle = '✅ Neue Fassung behalten';
    pushBody  = `Neue Fassung ersetzt ${matchPostid}`;
    pushUrl   = matchWeburl || (appHost ? `${appHost}/postbuch/${reservedPostid}` : `/postbuch/${reservedPostid}`);
  } else if (decision === 'keep_both') {
    pushTitle = isTimeout ? '📋 Frist abgelaufen – beide behalten' : '📋 Beide behalten';
    pushBody  = `Neuer Eintrag parallel zu ${matchPostid}`;
    pushUrl   = appHost ? `${appHost}/postbuch/${reservedPostid}` : `/postbuch/${reservedPostid}`;
  }
  if (pushTitle) {
    sendPushToAllUsers(
      { title: pushTitle, body: pushBody, tag: `dup-resolved-${reservedPostid}`, url: pushUrl, requireInteraction: false },
      { category: 'duplicate' },
    ).catch((e) => console.warn('[resolve-duplicate] Push-Fehler:', e.message));
  }
}

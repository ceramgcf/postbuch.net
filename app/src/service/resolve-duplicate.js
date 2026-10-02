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
import * as tracker from '../jobs/tracker.js';
import { enqueueDocument } from '../jobs/pipeline-queue.js';
import { loadDynamicSettings } from '../config.js';
import { appLog } from '../app-log.js';
import { sendPushToAllUsers } from '../lib/webpush.js';

export async function resolveDuplicate({ jobId, decision, source = 'unknown' }, settings = null) {
  const s = settings || await loadDynamicSettings();

  const suspension = await suspensionStore.get(jobId);
  if (!suspension) {
    return { ok: false, reason: 'Suspension nicht gefunden (evtl. bereits entschieden)' };
  }

  const { storage_id, storage_backend, discord_message_id, payload, step_offset, reserved_postid, match_postid, match_weburl } = suspension;

  try {
    if (decision === 'discard') {
      // ─ Neues Dokument → Papierkorb, Job als erledigt markieren ─
      const trashed = await getAdapter(storage_backend)
        .moveToTrash(storage_id, `Duplikat_${reserved_postid}_${Date.now()}.pdf`).catch(err => {
        console.warn(`[resolve-duplicate] moveToTrash fehlgeschlagen (${storage_id}): ${err.message}`);
        return null;
      });
      const trashUrl = trashed?.webUrl || null;

      await suspensionStore.deleteOne(jobId);
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

    await suspensionStore.deleteOne(jobId);
    await tracker.resume(jobId);
    enqueueDocument(resumedInput, jobId, stepOffsetResume);

    await _updateDiscordMessage(discord_message_id, s);
    await _postFollowup(decision, source, reserved_postid, match_postid, match_weburl, null, s);

    appLog('INFO', 'duplicate', `Job ${jobId}: ${decision} (${source}) — Wiederaufnahme eingereiht`);
    return { ok: true };
  } catch (err) {
    console.error(`[resolve-duplicate] Fehler bei Job ${jobId}:`, err.message);
    appLog('ERROR', 'duplicate', `resolve-duplicate Job ${jobId}: ${err.message}`);
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
    msg = isTimeout
      ? `🗑️ Auto-Verworfen — Qualität nicht besser. PostID \`${reservedPostid}\`${trashLink} · Bestand: \`${matchPostid}\``
      : `🗑️ Manuell verworfen — PostID \`${reservedPostid}\`${trashLink} · Bestand: \`${matchPostid}\``;
  } else if (decision === 'replace') {
    const entryLink = matchWeburl ? ` [Eintrag öffnen](${matchWeburl})` : '';
    msg = isTimeout
      ? `🔄 Auto-Akzeptiert (höhere Qualität) — \`${reservedPostid}\` ersetzt \`${matchPostid}\`.${entryLink}`
      : `✅ Manuell ersetzt — \`${reservedPostid}\` ersetzt \`${matchPostid}\`.${entryLink}`;
  } else if (decision === 'keep_both') {
    msg = `📋 Beide behalten — neuer Eintrag entsteht parallel zu \`${matchPostid}\``;
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
    pushTitle = isTimeout ? '🗑️ Auto-Verworfen' : '🗑️ Duplikat verworfen';
    pushBody  = `${reservedPostid} wurde verworfen. Bestand: ${matchPostid}`;
    pushUrl   = appHost ? `${appHost}/logs` : '/logs';
  } else if (decision === 'replace') {
    pushTitle = isTimeout ? '🔄 Auto-Ersetzt' : '✅ Ersetzt';
    pushBody  = `${reservedPostid} ersetzt ${matchPostid}`;
    pushUrl   = matchWeburl || (appHost ? `${appHost}/postbuch/${reservedPostid}` : `/postbuch/${reservedPostid}`);
  } else if (decision === 'keep_both') {
    pushTitle = '📋 Beide behalten';
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

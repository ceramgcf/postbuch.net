/**
 * service/duplicate-notifier.js — Duplikat-Entscheidungs-Benachrichtigung
 *
 * Wählt automatisch den richtigen Modus:
 *   - Bot konfiguriert → Embed mit drei Buttons (native Interactions)
 *   - Nur Webhook → Embed mit Magic-Link
 *   - Nichts konfiguriert → silent no-op
 *
 * @returns {Promise<string|null>} Discord-Message-ID (Bot-Modus) oder null
 */

import * as discord from '../lib/discord.js';
import { sign as signToken } from '../lib/decision-token.js';
import { loadDynamicSettings } from '../config.js';
import { sendPushToAllUsers } from '../lib/webpush.js';

const TIMEOUT_MIN_DEFAULT = 60;

/**
 * Sendet die Duplikat-Entscheidungs-Anfrage an Discord.
 *
 * @param {object} params
 * @param {string}  params.jobId
 * @param {string}  params.reservedPostID
 * @param {object}  params.dup             - { match: { postid, similarity, confidence, webUrl, betreff } }
 * @param {object}  params.extractedData   - LLM-Ergebnis mit qualityFlags
 * @param {string}  [params.onedriveWeburl] - WebURL der neuen Datei
 * @param {Date}    params.expiresAt
 * @param {object}  [params.settings]
 * @returns {Promise<string|null>} messageId oder null
 */
export async function requestDecision({ jobId, reservedPostID, dup, extractedData, onedriveWeburl, expiresAt }, settings = null) {
  const s = settings || await loadDynamicSettings();
  const timeoutMin = s.duplicate_decision_timeout_min || TIMEOUT_MIN_DEFAULT;

  const pb = extractedData.postbuch || {};
  const qf = extractedData.qualityFlags || {};

  const newConfidence = Number(qf.sicherheitsgrad || 0);
  const oldConfidence = Number(dup.match?.confidence || 0);
  const betterQuality = newConfidence > oldConfidence;
  const autoDecision = betterQuality ? 'replace' : 'discard';
  const autoDecisionLabel = betterQuality
    ? `🔄 Auto-Replace — neues Dokument (${Math.round(newConfidence * 100)}%) überschreibt ${dup.match?.postid} (${Math.round(oldConfidence * 100)}%)`
    : `🗑️ Auto-Discard — neues Dokument (${Math.round(newConfidence * 100)}%) hat keine höhere Qualität als ${dup.match?.postid} (${Math.round(oldConfidence * 100)}%) und wird verworfen`;

  const similarityPct = Math.round((dup.match?.similarity || 0) * 100);
  const expiresStr = expiresAt.toLocaleString('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  // ─── Embed-Inhalt ───
  const embed = {
    title: '⚠️ Duplikat-Verdacht',
    color: 0xf59e0b, // amber
    description:
      `Dokument **"${pb.betreff || '(kein Betreff)'}"** vom ${pb.briefdatum || '(kein Datum)'}\n` +
      `scheint ein Duplikat von **${dup.match?.postid}** ("${dup.match?.betreff || '–'}") zu sein.\n\n` +
      `**Neue reservierte ID:** \`${reservedPostID}\`\n` +
      `**Ähnlichkeit:** ${similarityPct}%\n` +
      `**Neue Qualität:** ${Math.round(newConfidence * 100)}% | **Alte Qualität:** ${Math.round(oldConfidence * 100)}%\n` +
      (betterQuality ? '\n📌 **Empfehlung: Bestehendes ersetzen** (neue Qualität ist höher)' : '') +
      `\n\n⏱️ Keine Reaktion in ${timeoutMin} Min. → **${autoDecisionLabel}**\n(Frist: ${expiresStr})`,
    fields: [
      { name: 'Bestehendes Dokument', value: dup.match?.webUrl ? `[${dup.match.postid} öffnen](${dup.match.webUrl})` : dup.match?.postid || '–', inline: true },
      { name: 'Neues Dokument', value: onedriveWeburl ? `[Auf OneDrive ansehen](${onedriveWeburl})` : '(kein Link)', inline: true },
    ],
    footer: { text: `Job-ID: ${jobId}` },
    timestamp: new Date().toISOString(),
  };

  // ─── Bot-Modus: Buttons ───
  if (s.discord_bot_token && s.discord_channel_id) {
    const components = [{
      type: 1, // ACTION_ROW
      components: [
        {
          type: 2, style: 3, // SUCCESS (green)
          label: 'Bestehendes ersetzen',
          custom_id: `dup:replace:${jobId}`,
        },
        {
          type: 2, style: 1, // PRIMARY (blue)
          label: 'Beide behalten',
          custom_id: `dup:keep_both:${jobId}`,
        },
        {
          type: 2, style: 4, // DANGER (red)
          label: 'Duplikat verwerfen',
          custom_id: `dup:discard:${jobId}`,
        },
      ],
    }];

    const messageId = await discord.sendEmbed({ embed, components, settings: s });
    _sendDuplicatePush(s, reservedPostID, pb, similarityPct, jobId);
    return messageId;
  }

  // ─── Webhook-Modus: Magic-Link ───
  if (s.discord_webhook_url) {
    const exp = Math.floor(expiresAt.getTime() / 1000);
    let magicLink = null;
    try {
      const token = await signToken({ jobId, exp });
      const host = s.app_host;
      magicLink = host ? `${host}/entscheidung/${jobId}?token=${token}` : null;
    } catch {
      magicLink = null;
    }

    const webhookEmbed = {
      ...embed,
      description: embed.description + (magicLink ? `\n\n🔗 [Entscheidung im Dashboard treffen](${magicLink})` : ''),
    };

    await discord.sendEmbed({ embed: webhookEmbed, settings: s });
    _sendDuplicatePush(s, reservedPostID, pb, similarityPct, jobId);
    return null;
  }

  // Nur Push (kein Discord konfiguriert)
  _sendDuplicatePush(s, reservedPostID, pb, similarityPct, jobId);
  return null;
}

function _sendDuplicatePush(s, reservedPostID, pb, similarityPct, jobId) {
  const appHost = (s?.app_host || '').replace(/\/$/, '');
  const url = appHost ? `${appHost}/logs` : '/logs';
  sendPushToAllUsers({
    title: '⚠️ DUPLIKAT-VERDACHT — Entscheidung erforderlich!',
    body: `"${pb.betreff || '(kein Betreff)'}" · ${similarityPct}% Übereinstimmung · ID: ${reservedPostID}`,
    tag: `dup-${jobId}`,
    url,
    requireInteraction: true,
  }, { category: 'duplicate' }).catch((e) => console.warn('[duplicate-notifier] Push-Fehler:', e.message));
}

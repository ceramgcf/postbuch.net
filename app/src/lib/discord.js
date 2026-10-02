/**
 * lib/discord.js — Discord-Benachrichtigungen
 *
 * Ersetzt: 4 Discord-Nodes in n8n.
 *
 * Unterstützt zwei Methoden (Bot hat Priorität):
 *   1. Bot API      → discord_bot_token + discord_channel_id in _settings
 *   2. Webhook-URL  → discord_webhook_url in _settings (Fallback)
 *
 * Wenn keines konfiguriert → stille No-Op (kein Fehler).
 * Discord-Limit: max. 2000 Zeichen pro Nachricht.
 */

import { loadDynamicSettings } from '../config.js';
import { appLog } from '../app-log.js';

const DISCORD_API = 'https://discord.com/api/v10';

// ─── Interne Sende-Funktion ──────────────────────────────────────────────────

async function sendViaWebhook(webhookUrl, text) {
  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content: text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[discord] Webhook-Fehler ${res.status}: ${body.slice(0, 200)}`);
    appLog('WARN', 'discord', `Webhook-Fehler ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function sendViaBotApi(token, channelId, text) {
  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bot ${token}`,
    },
    body: JSON.stringify({ content: text }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    console.error(`[discord] Bot API Fehler ${res.status}: ${body.slice(0, 200)}`);
    appLog('WARN', 'discord', `Bot API Fehler ${res.status}: ${body.slice(0, 200)}`);
  }
}

async function dispatch(text, s) {
  if (s.admin_notification_discord === false) return; // per Nutzereinstellung deaktiviert
  if (s.discord_bot_token && s.discord_channel_id) {
    return sendViaBotApi(s.discord_bot_token, s.discord_channel_id, text);
  }
  if (s.discord_webhook_url) {
    return sendViaWebhook(s.discord_webhook_url, text);
  }
  // Nicht konfiguriert → silent no-op
}

// ─── Embed + Component-Support ───────────────────────────────────────────────

/**
 * Sendet ein Embed-Objekt mit optionalen Buttons/Components.
 * Gibt messageId zurück (Bot-Modus), null (Webhook oder unkonfiguriert).
 *
 * @param {object} params
 * @param {object}   params.embed       - Discord-Embed-Objekt
 * @param {object[]} [params.components] - ActionRow-Komponenten (nur Bot)
 * @param {object}   [params.settings]  - Optional: bereits geladene Settings
 * @returns {Promise<string|null>} Discord-Message-ID oder null
 */
export async function sendEmbed({ embed, components, settings = null }) {
  const s = settings || await loadDynamicSettings();
  if (s.admin_notification_discord === false) return null; // per Nutzereinstellung deaktiviert

  if (s.discord_bot_token && s.discord_channel_id) {
    const body = { embeds: [embed] };
    if (components?.length) body.components = components;

    const res = await fetch(`${DISCORD_API}/channels/${s.discord_channel_id}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bot ${s.discord_bot_token}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[discord] sendEmbed Bot-Fehler ${res.status}: ${text.slice(0, 200)}`);
      appLog('WARN', 'discord', `sendEmbed Bot-Fehler ${res.status}`);
      return null;
    }

    const data = await res.json();
    return data.id || null;
  }

  if (s.discord_webhook_url) {
    // Webhook unterstützt keine Buttons — nur Embed senden
    const res = await fetch(s.discord_webhook_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ embeds: [embed] }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(`[discord] sendEmbed Webhook-Fehler ${res.status}: ${text.slice(0, 200)}`);
      appLog('WARN', 'discord', `sendEmbed Webhook-Fehler ${res.status}`);
    }
    return null; // Webhook gibt keine usable Message-ID zurück
  }

  return null; // nicht konfiguriert
}

/**
 * Editiert eine bestehende Bot-Nachricht (nur Bot-Modus).
 * Im Webhook-Modus: silent no-op.
 *
 * @param {string} messageId
 * @param {object} params
 * @param {string}  [params.content]         - Neuer Textinhalt
 * @param {object[]} [params.components]     - Neue Komponenten
 * @param {boolean}  [params.removeComponents] - Alle Komponenten entfernen
 * @param {object}   [params.settings]
 */
export async function editMessage(messageId, { content, components, removeComponents } = {}, settings = null) {
  const s = settings || await loadDynamicSettings();
  if (!s.discord_bot_token || !s.discord_channel_id || !messageId) return;

  const body = {};
  if (content !== undefined) body.content = content;
  if (removeComponents) body.components = [];
  else if (components) body.components = components;

  const res = await fetch(`${DISCORD_API}/channels/${s.discord_channel_id}/messages/${messageId}`, {
    method: 'PATCH',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bot ${s.discord_bot_token}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    console.error(`[discord] editMessage-Fehler ${res.status}: ${text.slice(0, 200)}`);
  }
}

/**
 * Löscht eine Bot-Nachricht (nur Bot-Modus).
 * @param {string} messageId
 * @param {object} [settings]
 */
export async function deleteMessage(messageId, settings = null) {
  const s = settings || await loadDynamicSettings();
  if (!s.discord_bot_token || !s.discord_channel_id || !messageId) return;

  const res = await fetch(`${DISCORD_API}/channels/${s.discord_channel_id}/messages/${messageId}`, {
    method: 'DELETE',
    headers: { 'Authorization': `Bot ${s.discord_bot_token}` },
  });

  if (!res.ok && res.status !== 404) {
    const text = await res.text().catch(() => '');
    console.error(`[discord] deleteMessage-Fehler ${res.status}: ${text.slice(0, 200)}`);
  }
}

// ─── Öffentliche API ─────────────────────────────────────────────────────────

/**
 * Sendet eine einzelne Nachricht an Discord.
 * Wird automatisch auf 2000 Zeichen abgeschnitten falls nötig.
 *
 * @param {string} content   - Nachrichteninhalt (Markdown unterstützt)
 * @param {object} [settings] - Optional: bereits geladene Settings (vermeidet DB-Query)
 */
export async function sendMessage(content, settings = null) {
  const s = settings || await loadDynamicSettings();

  // Discord-Limit: 2000 Zeichen
  const MAX = 2000;
  let text = content;
  if (text.length > MAX) {
    text = text.slice(0, MAX - 40) + '\n…*(Nachricht abgeschnitten)*';
  }

  await dispatch(text, s);
}

/**
 * Sendet eine lange Nachricht aufgeteilt in mehrere Discord-Nachrichten.
 * Sektionen werden so zusammengefasst, dass jede Nachricht ≤ 2000 Zeichen hat.
 *
 * @param {string[]} sections  - Array von Textabschnitten (werden mit \n\n verbunden)
 * @param {object}  [settings] - Optional: bereits geladene Settings
 */
export async function sendLongMessage(sections, settings = null) {
  const s = settings || await loadDynamicSettings();

  const MAX = 2000;
  const SEPARATOR = '\n\n';

  const chunks = [];
  let current = '';

  for (const section of sections) {
    const candidate = current
      ? current + SEPARATOR + section
      : section;

    if (candidate.length <= MAX) {
      current = candidate;
    } else {
      if (current) chunks.push(current);

      if (section.length > MAX) {
        let remaining = section;
        while (remaining.length > 0) {
          chunks.push(remaining.slice(0, MAX));
          remaining = remaining.slice(MAX);
        }
        current = '';
      } else {
        current = section;
      }
    }
  }
  if (current) chunks.push(current);

  for (const chunk of chunks) {
    await dispatch(chunk, s);
  }
}

